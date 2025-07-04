/**
 * A secure vault for storing key-value data, encrypted with AES-GCM.
 * It uses the Web Crypto API, available in modern browsers and Node.js.
 */
class SelectorVault {
	// Static configuration for the encryption parameters
	public static readonly STORAGE_KEY = 'omniForm_selectorVault';
	private static readonly SALT_LENGTH = 16;
	private static readonly IV_LENGTH = 12;
	private static readonly DEFAULT_PBKDF2_ITERATIONS = 100000;

	// Instance properties
	private masterKey: string | null = null;
	private storage: Storage;
    private iterations: number;

	constructor(storage: Storage = localStorage, iterations?: number) {
		this.storage = storage;
        this.iterations = iterations || SelectorVault.DEFAULT_PBKDF2_ITERATIONS;
	}

	/**
	 * Initializes the vault with a master key, verifying it against existing data if present.
	 * @param masterKey The secret key to use for encryption and decryption.
	 */
	async initVault(masterKey: string): Promise<void> {
		if (!masterKey) {
			throw new Error('Master key cannot be empty');
		}
		this.masterKey = masterKey;

		const existing = this.storage.getItem(SelectorVault.STORAGE_KEY);
        if (existing) {
          try {
            await this.decrypt(existing); // throws if wrong key
          } catch {
            this.masterKey = null;
            throw new Error('Invalid master key for existing vault');
          }
        }
	}

  /**
   * Encrypt an arbitrary serialisable object and return a string suitable for
   * persistence.
   * Format (v1):
   * "v1." + base64( 4-byte BE iterations | salt | iv | ciphertext )
   */
  async encrypt(data: any): Promise<string> {
    this.ensureKey();

    // Derivation parameters
    const salt = SelectorVault.randomBytes(SelectorVault.SALT_LENGTH);
    const iv = SelectorVault.randomBytes(SelectorVault.IV_LENGTH);
    const cryptoKey = await this.deriveKey(
      this.masterKey as string,
      salt,
      this.iterations
    );

    // Encrypt
    const encoded = SelectorVault.textEncode(JSON.stringify(data));
    const cipherBuf = await this.subtle().encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      encoded
    );

    // Pack metadata
    const iterBytes = new Uint8Array(4);
    new DataView(iterBytes.buffer).setUint32(0, this.iterations, false); // big-endian
    const packed = SelectorVault.concatUint8Arrays([
      iterBytes,
      salt,
      iv,
      new Uint8Array(cipherBuf),
    ]);
    return `v1.${SelectorVault.base64Encode(packed)}`;
  }

  /**
   * Decrypt a ciphertext produced by `encrypt()`.
   * Accepts legacy payloads that
   * pre-date versioned headers.
   */
  async decrypt(cipher: string): Promise<any> {
    this.ensureKey();

    // Detect payload version
    const isV1 = cipher.startsWith('v1.');
    const b64 = isV1 ? cipher.slice(3) : cipher;

    let packed: Uint8Array;
    try {
      packed = new Uint8Array(SelectorVault.base64Decode(b64));
    } catch {
      throw new Error('InvalidCiphertextError: Ciphertext is not valid base64');
    }

    // Minimum length validation
    const minLen =
      (isV1 ? 4 : 0) +
      SelectorVault.SALT_LENGTH +
      SelectorVault.IV_LENGTH +
      1; // at least 1 byte of data
    if (packed.length < minLen) {
      throw new Error('InvalidCiphertextError: Ciphertext too short or malformed');
    }

    // Parse header
    let offset = 0;
    let iterations = SelectorVault.DEFAULT_PBKDF2_ITERATIONS;
    if (isV1) {
      iterations = new DataView(
        packed.buffer,
        packed.byteOffset,
        packed.byteLength
      ).getUint32(0, false); // big-endian
      if (iterations === 0) {
        throw new Error('InvalidCiphertextError: Invalid iteration count');
      }
      offset += 4;
    }

    const salt = packed.slice(offset, offset + SelectorVault.SALT_LENGTH);
    offset += SelectorVault.SALT_LENGTH;

    const iv = packed.slice(offset, offset + SelectorVault.IV_LENGTH);
    offset += SelectorVault.IV_LENGTH;

    const data = packed.slice(offset);

    // Derive & decrypt
    const cryptoKey = await this.deriveKey(
      this.masterKey as string,
      salt,
      iterations
    );

    let plainBuf: ArrayBuffer;
    try {
      plainBuf = await this.subtle().decrypt(
        { name: 'AES-GCM', iv },
        cryptoKey,
        data
      );
    } catch {
      throw new Error('InvalidCiphertextError: Authentication failed');
    }

    try {
      const jsonStr = SelectorVault.textDecode(new Uint8Array(plainBuf));
      return JSON.parse(jsonStr);
    } catch {
      throw new Error('InvalidCiphertextError: Plaintext decoding failed');
    }
  }

  /** Persist a key/value map */
  async save(map: Record<string, string> | Map<string, string>): Promise<void> {
    const obj: Record<string, string> =
      map instanceof Map ? Object.fromEntries(map) : { ...map };
    const cipher = await this.encrypt(obj);
    this.storage.setItem(SelectorVault.STORAGE_KEY, cipher);
  }

  /** Load the vault contents (empty map if none) */
  async load(): Promise<Map<string, string>> {
    const cipher = this.storage.getItem(SelectorVault.STORAGE_KEY);
    if (!cipher) return new Map<string, string>();
    const obj = await this.decrypt(cipher);
    return new Map(Object.entries(obj));
  }

  /**
   * Rotate master key. Ensures the vault is successfully re-saved before
   * committing to the new key.
   */
  async rotateKey(newKey: string): Promise<void> {
    const data = await this.load();
    const oldKey = this.masterKey;
    try {
      this.masterKey = newKey;
      await this.save(data);
    } catch (err) {
      // rollback
      this.masterKey = oldKey;
      throw err;
    }
  }

	/* ------------------------------------------------------------------ *
	 * INTERNAL UTILITIES                                                 *
	 * ------------------------------------------------------------------ */

	private ensureKey(): void {
		if (!this.masterKey) {
			throw new Error('Vault not initialized. Call initVault(masterKey) first.');
		}
	}

	private subtle(): SubtleCrypto {
		if (typeof crypto !== 'undefined' && crypto.subtle) return crypto.subtle;
		throw new Error('WebCrypto is not available in this environment.');
	}

	private async deriveKey(
		password: string,
		salt: Uint8Array,
		iterations: number
	): Promise<CryptoKey> {
		const keyMaterial = await this.subtle().importKey(
			'raw',
			SelectorVault.textEncode(password),
			'PBKDF2',
			false,
			['deriveKey']
		);
		return this.subtle().deriveKey(
			{
				name: 'PBKDF2',
				salt,
				iterations,
				hash: 'SHA-256',
			},
			keyMaterial,
			{ name: 'AES-GCM', length: 256 },
			false,
			['encrypt', 'decrypt']
		);
	}

	/* ------------------------------------------------------------------ *
	 * STATIC HELPERS                                                     *
	 * ------------------------------------------------------------------ */

	private static textEncoder = new TextEncoder();
	private static textDecoder = new TextDecoder();

	private static textEncode(str: string): Uint8Array {
		return SelectorVault.textEncoder.encode(str);
	}

	private static textDecode(data: Uint8Array): string {
		return SelectorVault.textDecoder.decode(data);
	}

	private static randomBytes(length: number): Uint8Array {
		const arr = new Uint8Array(length);
		if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
			crypto.getRandomValues(arr);
		} else {
			// Node.js fallback
			const nodeCrypto = require('crypto');
			arr.set(nodeCrypto.randomBytes(length));
		}
		return arr;
	}

	private static concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
		const total = arrays.reduce((acc, curr) => acc + curr.length, 0);
		const out = new Uint8Array(total);
		let offset = 0;
		arrays.forEach((a) => {
			out.set(a, offset);
			offset += a.length;
		});
		return out;
	}

	private static base64Encode(buffer: Uint8Array): string {
		if (typeof Buffer !== 'undefined') {
			// Node.js
			return Buffer.from(buffer).toString('base64');
		}
		// Browser
		let binary = '';
		const chunkSize = 0x8000; // 32k
		for (let i = 0; i < buffer.length; i += chunkSize) {
			binary += String.fromCharCode(
				...buffer.subarray(i, Math.min(buffer.length, i + chunkSize))
			);
		}
		return btoa(binary);
	}

	private static base64Decode(b64: string): Uint8Array {
		if (typeof Buffer !== 'undefined') {
			return new Uint8Array(Buffer.from(b64, 'base64'));
		}
		const binary = atob(b64);
		const len = binary.length;
		const bytes = new Uint8Array(len);
		for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	}
}

export default SelectorVault;