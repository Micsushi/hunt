import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Gmail bootstrap keeps OAuth and mailbox values inside the trusted child", async () => {
  const [child, coordinator, cli, ownership] = await Promise.all([
    readFile("src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts", "utf8"),
    readFile("src/composition/s2-gmail-bootstrap.ts", "utf8"),
    readFile("src/composition/s2-gmail-bootstrap-cli.ts", "utf8"),
    readFile("tests/security/privacy/fixtures/gmail-bootstrap-ownership.json", "utf8"),
  ]);
  const embedded = /\$source = @'\r?\n[\s\S]*?\r?\n'@/u.exec(child)?.[0] ?? "";
  const ordinaryNodeSurface = child.replace(embedded, "");
  assert.match(embedded, /client_secret/u);
  assert.match(embedded, /senderAddress/u);
  assert.doesNotMatch(embedded, /InputBox|Microsoft\.VisualBasic|Interaction\./u);
  assert.doesNotMatch(ordinaryNodeSurface, /process\.env|process\.argv|client_secret|senderAddress/iu);
  assert.match(child, /env:\s*\{\s*SystemRoot:/u);
  assert.doesNotMatch(coordinator, /access_token|refresh_token|client_secret|senderAddress|recipientAddress/u);
  assert.doesNotMatch(cli, /readFile\([^)]*(?:installedClient|senderPolicy)|client_secret|senderAddress/iu);
  assert.doesNotMatch(cli, /environment\[[^\]]+\]|process\.env\./u);
  assert.match(cli, /SECRET_ENVIRONMENT/u);
  assert.deepEqual(JSON.parse(ownership), [
    {
      value: "expected_desktop_client_id",
      ordinaryNode: "exact_equality_input",
      trustedWindowsHelper: "exact_equality_check",
      durableOutput: "none",
    },
    {
      value: "installed_client_canonical_path",
      ordinaryNode: "admission_and_acl_only",
      trustedWindowsHelper: "bounded_file_open",
      durableOutput: "none",
    },
    {
      value: "installed_client_json_and_client_secret",
      ordinaryNode: "none",
      trustedWindowsHelper: "sole_reader_token_form_only",
      durableOutput: "none",
    },
    {
      value: "sender_policy_canonical_path",
      ordinaryNode: "admission_and_acl_only",
      trustedWindowsHelper: "bounded_file_open",
      durableOutput: "none",
    },
    {
      value: "sender_address",
      ordinaryNode: "none",
      trustedWindowsHelper: "sole_reader_current_bundle_binding",
      durableOutput: "dpapi_ciphertext_only",
    },
    {
      value: "gmail_access_token_and_mailbox_identity",
      ordinaryNode: "none",
      trustedWindowsHelper: "oauth_profile_and_bundle_sealing",
      durableOutput: "dpapi_ciphertext_only",
    },
  ]);
});
