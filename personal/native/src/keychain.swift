import AppKit
import CryptoKit
import Foundation
import Security

// Only ciphertext and SDK state cross the private host pipe. The AES key stays in this process.
enum VaultFailure: Error { case invalidOperation, keychainUnavailable, invalidData }

func encryptionKey(create: Bool) throws -> SymmetricKey {
    let identity: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "dev.dualread.personal.oauth",
        kSecAttrAccount as String: "local-encryption-v1"
    ]
    var lookup = identity
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &item)
    if status == errSecSuccess, let bytes = item as? Data, bytes.count == 32 {
        return SymmetricKey(data: bytes)
    }
    guard status == errSecItemNotFound && create else { throw VaultFailure.keychainUnavailable }
    let key = SymmetricKey(size: .bits256)
    var newItem = identity
    newItem[kSecValueData as String] = key.withUnsafeBytes { Data($0) }
    newItem[kSecAttrLabel as String] = "DualRead Personal local credential encryption"
    let addStatus = SecItemAdd(newItem as CFDictionary, nil)
    if addStatus == errSecDuplicateItem { return try encryptionKey(create: false) }
    guard addStatus == errSecSuccess else { throw VaultFailure.keychainUnavailable }
    return key
}

do {
    guard CommandLine.arguments.count == 2 else { throw VaultFailure.invalidOperation }
    let action = CommandLine.arguments[1]
    let input = FileHandle.standardInput.readDataToEndOfFile()
    if action == "open-browser" {
        guard input.count <= 16 * 1024, let text = String(data: input, encoding: .utf8),
              let url = URL(string: text), url.scheme == "https", url.host == "auth.openai.com",
              url.user == nil, url.password == nil, url.port == nil || url.port == 443,
              NSWorkspace.shared.open(url) else { throw VaultFailure.invalidData }
        exit(0)
    }
    guard action == "encrypt" || action == "decrypt" else { throw VaultFailure.invalidOperation }
    guard input.count <= 3 * 1024 * 1024 else { throw VaultFailure.invalidData }
    let key = try encryptionKey(create: action == "encrypt")
    let output: Data
    if action == "encrypt" {
        guard let sealed = try AES.GCM.seal(input, using: key).combined else { throw VaultFailure.invalidData }
        output = sealed
    } else {
        output = try AES.GCM.open(AES.GCM.SealedBox(combined: input), using: key)
    }
    FileHandle.standardOutput.write(output)
} catch {
    exit(1)
}
