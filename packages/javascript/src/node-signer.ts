/**
 * Ed25519 request signing for Node — the detached-JWS scheme the OGR runtime
 * verifies on `ogr-batch-signature` headers (the same scheme the openclaw and
 * hermes integrations produce):
 *
 *   header = b64url({"alg":"EdDSA","kid":<keyId>,"b64":false,"crit":["b64"]})
 *   value  = header + ".." + b64url(Ed25519-sign(header + "." + body))
 *
 * `node:crypto` is imported lazily inside the factory so that importing
 * `@openguardrails/core` stays possible in non-Node runtimes (WASM/edge);
 * only calling `createNodeSigner` requires Node.
 */
import type { KeyObject } from "node:crypto"
import type { Signer } from "./client.js"

/** An Ed25519 private key: a `node:crypto` KeyObject, or its JWK `d`/`x` parts. */
export type Ed25519PrivateKey = KeyObject | { d: string; x: string }

/**
 * Build a {@link Signer} from an Ed25519 private key and the `key_id` returned
 * by `POST /v1/enroll`. Pass the result as `RuntimeClientOptions.signer`.
 */
export async function createNodeSigner(privateKey: Ed25519PrivateKey, keyId: string): Promise<Signer> {
  const { createPrivateKey, sign } = await import("node:crypto")
  const key: KeyObject =
    "d" in privateKey && typeof privateKey.d === "string"
      ? createPrivateKey({
          key: { kty: "OKP", crv: "Ed25519", d: privateKey.d, x: privateKey.x },
          format: "jwk",
        })
      : (privateKey as KeyObject)
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", kid: keyId, b64: false, crit: ["b64"] }),
  ).toString("base64url")
  return {
    sign(body: Uint8Array): string {
      const signature = sign(
        null,
        Buffer.concat([Buffer.from(header, "ascii"), Buffer.from("."), Buffer.from(body)]),
        key,
      )
      return `${header}..${signature.toString("base64url")}`
    },
  }
}
