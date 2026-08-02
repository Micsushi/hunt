import { spawn } from "node:child_process";

import type { TargetIdentityV1 } from "../../../contracts/live/index.ts";

const DEFAULT_BOUND = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const INPUT_MAGIC = Buffer.from("HAGI", "ascii");
const OUTPUT_MAGIC = Buffer.from("HAGS", "ascii");

const INTERACTIVE_GMAIL_OAUTH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Web;
using System.Web.Script.Serialization;
using Microsoft.VisualBasic;

public static class HuntInteractiveGmailOAuthSealer
{
    private const string Scope = "https://www.googleapis.com/auth/gmail.readonly";
    private const string AuthorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
    private const string TokenEndpoint = "https://oauth2.googleapis.com/token";
    private const string ProfileEndpoint = "https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress";
    private const int MaximumSection = 1048576;

    private sealed class FlowException : Exception
    {
        public int ExitCode { get; private set; }
        public FlowException(int exitCode) { ExitCode = exitCode; }
    }

    public static int Run()
    {
        byte[][] input = null;
        byte[] account = null;
        byte[] bundle = null;
        byte[] sealedValue = null;
        Token token = null;
        InstalledClient installedClient = null;
        try
        {
            input = ReadInput();
            account = ProtectedData.Unprotect(input[2], input[1], DataProtectionScope.CurrentUser);
            string accountEmail = ReadAccountEmail(account);
            string clientId = StrictUtf8(input[3]);
            string installedClientConfigPath = StrictUtf8(input[4]);
            IDictionary<string, object> binding = ExactObject(StrictUtf8(input[5]));
            IDictionary<string, object> gmailMetadata = ExactObject(StrictUtf8(input[0]));
            ValidateClient(clientId);
            ValidateBinding(binding);
            installedClient = ReadInstalledClient(installedClientConfigPath, clientId);

            token = Authorize(clientId, installedClient.Secret);
            ValidateExpiry(gmailMetadata, token.ExpiresIn, token.ReceivedAt);
            string profileEmail = ProfileEmail(token.AccessValue);
            if (!String.Equals(accountEmail, profileEmail, StringComparison.OrdinalIgnoreCase))
                throw new FlowException(4);
            if (!ValidEmail(profileEmail) || profileEmail != profileEmail.ToLowerInvariant())
                throw new FlowException(4);
            string sender = Interaction.InputBox(
                "Authorized mailbox confirmed. Enter only the exact lowercase From email shown on the new Workday verification message. Never paste a verification link or token.",
                "Hunt Gmail sender policy",
                ""
            );
            if (String.IsNullOrEmpty(sender)) throw new FlowException(2);
            if (!ValidEmail(sender) || sender != sender.ToLowerInvariant())
                throw new FlowException(3);

            IDictionary<string, object> exactBundle = new Dictionary<string, object>();
            exactBundle["format"] = "gmail-oauth-bundle-v1";
            exactBundle["accessValue"] = token.AccessValue;
            exactBundle["journeyId"] = binding["journeyId"];
            exactBundle["recipientBindingId"] = binding["recipientBindingId"];
            exactBundle["senderPolicyId"] = binding["senderPolicyId"];
            exactBundle["target"] = binding["target"];
            exactBundle["scope"] = Scope;
            exactBundle["recipientAddress"] = profileEmail;
            exactBundle["senderAddress"] = sender;
            exactBundle["verificationHost"] = binding["verificationHost"];
            exactBundle["verificationTenant"] = binding["verificationTenant"];
            exactBundle["verificationTtlSeconds"] = binding["verificationTtlSeconds"];
            bundle = new UTF8Encoding(false, true).GetBytes(
                new JavaScriptSerializer().Serialize(exactBundle)
            );
            sealedValue = ProtectedData.Protect(bundle, input[0], DataProtectionScope.CurrentUser);
            WriteOutput(sealedValue);
            return 0;
        }
        catch (FlowException error) { return error.ExitCode; }
        catch { return 7; }
        finally
        {
            Clear(sealedValue);
            Clear(bundle);
            Clear(account);
            if (token != null) token.Clear();
            if (installedClient != null) installedClient.Clear();
            if (input != null) foreach (byte[] section in input) Clear(section);
        }
    }

    private static byte[][] ReadInput()
    {
        BinaryReader reader = new BinaryReader(Console.OpenStandardInput());
        byte[] magic = reader.ReadBytes(4);
        if (magic.Length != 4 || magic[0] != 72 || magic[1] != 65 || magic[2] != 71 || magic[3] != 73)
            throw new InvalidDataException();
        if (reader.ReadByte() != 1 || reader.ReadByte() != 6) throw new InvalidDataException();
        byte[][] sections = new byte[6][];
        for (int index = 0; index < sections.Length; index++)
        {
            int length = reader.ReadInt32();
            if (length < 1 || length > MaximumSection) throw new InvalidDataException();
            sections[index] = reader.ReadBytes(length);
            if (sections[index].Length != length) throw new EndOfStreamException();
        }
        if (reader.BaseStream.ReadByte() != -1) throw new InvalidDataException();
        Clear(magic);
        return sections;
    }

    private static string ReadAccountEmail(byte[] value)
    {
        BinaryReader reader = new BinaryReader(new MemoryStream(value, false));
        byte[] magic = reader.ReadBytes(4);
        if (magic.Length != 4 || magic[0] != 72 || magic[1] != 65 || magic[2] != 67 || magic[3] != 66)
            throw new InvalidDataException();
        if (reader.ReadByte() != 1 || reader.ReadByte() != 2 || reader.ReadByte() != 1)
            throw new InvalidDataException();
        int emailLength = reader.ReadInt32();
        if (emailLength < 1 || emailLength > 320) throw new InvalidDataException();
        byte[] emailBytes = reader.ReadBytes(emailLength);
        if (emailBytes.Length != emailLength || reader.ReadByte() != 2) throw new InvalidDataException();
        int passwordLength = reader.ReadInt32();
        if (passwordLength < 1 || passwordLength > 4096) throw new InvalidDataException();
        byte[] password = reader.ReadBytes(passwordLength);
        if (password.Length != passwordLength || reader.BaseStream.ReadByte() != -1)
            throw new InvalidDataException();
        string email = StrictUtf8(emailBytes);
        Clear(emailBytes);
        Clear(password);
        Clear(magic);
        if (!ValidEmail(email)) throw new InvalidDataException();
        return email;
    }

    private sealed class Token
    {
        public string AccessValue;
        public int ExpiresIn;
        public DateTimeOffset ReceivedAt;
        public void Clear() { AccessValue = null; }
    }

    private sealed class InstalledClient
    {
        public string Id;
        public string Secret;
        public void Clear() { Id = null; Secret = null; }
    }

    private static InstalledClient ReadInstalledClient(string path, string expectedClientId)
    {
        byte[] bytes = null;
        try
        {
            if (String.IsNullOrWhiteSpace(path) || path.Length > 32768 ||
                !String.Equals(Path.GetFullPath(path), path, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException();
            FileInfo info = new FileInfo(path);
            if (!info.Exists || info.Length < 2 || info.Length > 65536 ||
                (info.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException();
            bytes = File.ReadAllBytes(path);
            if (bytes.Length != info.Length || bytes.Length < 2 || bytes.Length > 65536 ||
                (bytes.Length >= 3 && bytes[0] == 239 && bytes[1] == 187 && bytes[2] == 191))
                throw new InvalidDataException();
            IDictionary<string, object> root = ExactObject(StrictUtf8(bytes));
            ExactKeys(root, new string[] { "installed" });
            IDictionary<string, object> installed = root["installed"] as IDictionary<string, object>;
            if (installed == null) throw new InvalidDataException();
            ExactKeys(installed, new string[] {
                "auth_provider_x509_cert_url", "auth_uri", "client_id", "client_secret",
                "project_id", "redirect_uris", "token_uri"
            });
            string id = StringField(installed, "client_id", 30, 200);
            ValidateClient(id);
            if (!String.Equals(id, expectedClientId, StringComparison.Ordinal))
                throw new InvalidDataException();
            if (StringField(installed, "auth_uri", AuthorizationEndpoint.Length, AuthorizationEndpoint.Length) != AuthorizationEndpoint ||
                StringField(installed, "token_uri", TokenEndpoint.Length, TokenEndpoint.Length) != TokenEndpoint ||
                StringField(installed, "auth_provider_x509_cert_url", 42, 42) != "https://www.googleapis.com/oauth2/v1/certs")
                throw new InvalidDataException();
            StringField(installed, "project_id", 1, 200);
            string secret = StringField(installed, "client_secret", 1, 4096);
            ValidateLoopbackRedirects(installed);
            return new InstalledClient { Id = id, Secret = secret };
        }
        catch { throw new FlowException(9); }
        finally { Clear(bytes); }
    }

    private static void ValidateLoopbackRedirects(IDictionary<string, object> installed)
    {
        object raw;
        if (!installed.TryGetValue("redirect_uris", out raw)) throw new InvalidDataException();
        object[] redirects = raw as object[];
        if (redirects == null || redirects.Length < 1 || redirects.Length > 4)
            throw new InvalidDataException();
        foreach (object item in redirects)
        {
            string text = item as string;
            Uri uri;
            if (text == null || text.Length < 1 || text.Length > 256 ||
                !Uri.TryCreate(text, UriKind.Absolute, out uri) || uri.Scheme != "http" ||
                !(uri.Host == "localhost" || uri.Host == "127.0.0.1" || uri.Host == "[::1]") ||
                !String.IsNullOrEmpty(uri.UserInfo) || !String.IsNullOrEmpty(uri.Query) ||
                !String.IsNullOrEmpty(uri.Fragment) || uri.AbsolutePath != "/")
                throw new InvalidDataException();
        }
    }

    private static Token Authorize(string clientId, string clientSecret)
    {
        byte[] verifierBytes = RandomBytes(64);
        byte[] stateBytes = RandomBytes(32);
        string verifier = Base64Url(verifierBytes);
        string state = Base64Url(stateBytes);
        Clear(verifierBytes);
        Clear(stateBytes);
        byte[] challengeBytes = SHA256.Create().ComputeHash(Encoding.ASCII.GetBytes(verifier));
        string challenge = Base64Url(challengeBytes);
        Clear(challengeBytes);
        TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
        try
        {
            listener.Start(1);
            int port = ((IPEndPoint)listener.LocalEndpoint).Port;
            string redirect = "http://127.0.0.1:" + port + "/oauth2callback";
            string authorization = AuthorizationEndpoint + "?" + Form(new Dictionary<string, string> {
                { "client_id", clientId }, { "redirect_uri", redirect },
                { "response_type", "code" }, { "scope", Scope }, { "state", state },
                { "code_challenge", challenge }, { "code_challenge_method", "S256" }
            });
            Process.Start(new ProcessStartInfo(authorization) { UseShellExecute = true });
            string code = ReceiveCode(listener, port, state);
            DateTimeOffset receivedAt = DateTimeOffset.UtcNow;
            IDictionary<string, object> response = RequestJson(
                TokenEndpoint,
                "POST",
                Form(new Dictionary<string, string> {
                    { "code", code }, { "client_id", clientId },
                    { "client_secret", clientSecret },
                    { "code_verifier", verifier }, { "redirect_uri", redirect },
                    { "grant_type", "authorization_code" }
                }),
                null,
                65536
            );
            string access = StringField(response, "access_token", 1, 4096);
            if (StringField(response, "token_type", 6, 16) != "Bearer")
                throw new FlowException(3);
            if (StringField(response, "scope", Scope.Length, Scope.Length) != Scope)
                throw new FlowException(5);
            int expires = IntegerField(response, "expires_in", 120, 7200);
            code = null;
            verifier = null;
            state = null;
            challenge = null;
            return new Token { AccessValue = access, ExpiresIn = expires, ReceivedAt = receivedAt };
        }
        finally
        {
            clientSecret = null;
            listener.Stop();
        }
    }

    private static string ReceiveCode(TcpListener listener, int port, string state)
    {
        IAsyncResult pending = listener.BeginAcceptTcpClient(null, null);
        if (!pending.AsyncWaitHandle.WaitOne(TimeSpan.FromMinutes(5))) throw new FlowException(8);
        using (TcpClient client = listener.EndAcceptTcpClient(pending))
        {
            IPEndPoint peer = client.Client.RemoteEndPoint as IPEndPoint;
            if (peer == null || !IPAddress.IsLoopback(peer.Address)) throw new FlowException(3);
            client.ReceiveTimeout = 10000;
            client.SendTimeout = 10000;
            NetworkStream stream = client.GetStream();
            byte[] request = ReadHeaders(stream, 16384);
            string text = Encoding.ASCII.GetString(request);
            Clear(request);
            string[] lines = text.Split(new string[] { "\r\n" }, StringSplitOptions.None);
            string[] first = lines[0].Split(' ');
            if (first.Length != 3 || first[0] != "GET" || first[2] != "HTTP/1.1")
                throw new FlowException(3);
            string expectedHost = "127.0.0.1:" + port;
            int hostCount = 0;
            foreach (string line in lines)
                if (line.StartsWith("Host:", StringComparison.OrdinalIgnoreCase))
                {
                    hostCount++;
                    if (line.Substring(5).Trim() != expectedHost) throw new FlowException(3);
                }
            if (hostCount != 1) throw new FlowException(3);
            foreach (string line in lines)
            {
                if (line.StartsWith("Transfer-Encoding:", StringComparison.OrdinalIgnoreCase))
                    throw new FlowException(3);
                if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase) && line.Substring(15).Trim() != "0")
                    throw new FlowException(3);
            }
            Uri callback = new Uri("http://" + expectedHost + first[1]);
            if (callback.AbsolutePath != "/oauth2callback" || !String.IsNullOrEmpty(callback.Fragment))
                throw new FlowException(3);
            var query = HttpUtility.ParseQueryString(callback.Query);
            if (query.GetValues("state") == null || query.GetValues("state").Length != 1 || query["state"] != state)
                throw new FlowException(3);
            string error = query["error"];
            string code = query["code"];
            if (!String.IsNullOrEmpty(error) || String.IsNullOrEmpty(code)) throw new FlowException(error == "access_denied" ? 2 : 3);
            if (query.GetValues("code").Length != 1 || code.Length > 4096) throw new FlowException(3);
            byte[] response = Encoding.ASCII.GetBytes(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\n" +
                "Cache-Control: no-store\r\nPragma: no-cache\r\nConnection: close\r\n" +
                "Content-Length: 53\r\n\r\nAuthorization received. Return to Hunt and close tab."
            );
            stream.Write(response, 0, response.Length);
            stream.Flush();
            Clear(response);
            return code;
        }
    }

    private static string ProfileEmail(string access)
    {
        IDictionary<string, object> profile = RequestJson(
            ProfileEndpoint, "GET", null, "Bearer " + access, 16384
        );
        return StringField(profile, "emailAddress", 3, 254);
    }

    private static IDictionary<string, object> RequestJson(
        string url, string method, string body, string authorization, int bound)
    {
        ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
        request.Method = method;
        request.AllowAutoRedirect = false;
        request.Timeout = 30000;
        request.ReadWriteTimeout = 30000;
        request.Accept = "application/json";
        if (authorization != null) request.Headers[HttpRequestHeader.Authorization] = authorization;
        if (body != null)
        {
            byte[] payload = Encoding.UTF8.GetBytes(body);
            request.ContentType = "application/x-www-form-urlencoded";
            request.ContentLength = payload.Length;
            using (Stream stream = request.GetRequestStream()) stream.Write(payload, 0, payload.Length);
            Clear(payload);
        }
        try
        {
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            {
                if (response.StatusCode != HttpStatusCode.OK) throw new FlowException(3);
                if (response.ContentType == null || !response.ContentType.StartsWith("application/json", StringComparison.OrdinalIgnoreCase))
                    throw new FlowException(3);
                byte[] bytes = ReadBounded(response.GetResponseStream(), bound);
                try { return ExactObject(StrictUtf8(bytes)); }
                finally { Clear(bytes); }
            }
        }
        catch (WebException) { throw new FlowException(3); }
    }

    private static void ValidateExpiry(IDictionary<string, object> metadata, int expiresIn, DateTimeOffset receivedAt)
    {
        DateTimeOffset issued = ExactInstant(StringField(metadata, "issuedAt", 24, 24));
        DateTimeOffset configured = ExactInstant(StringField(metadata, "expiresAt", 24, 24));
        DateTimeOffset tokenLimit = receivedAt.AddSeconds(expiresIn - 60);
        DateTimeOffset localCap = issued.AddMinutes(55);
        if (configured <= receivedAt || configured > tokenLimit || configured > localCap)
            throw new FlowException(6);
    }

    private static void ValidateClient(string value)
    {
        if (value.Length < 30 || value.Length > 200 || !value.EndsWith(".apps.googleusercontent.com", StringComparison.Ordinal))
            throw new FlowException(3);
    }

    private static void ValidateBinding(IDictionary<string, object> value)
    {
        string[] keys = { "journeyId", "recipientBindingId", "senderPolicyId", "target", "verificationHost", "verificationTenant", "verificationTtlSeconds" };
        if (value.Count != keys.Length) throw new FlowException(3);
        foreach (string key in keys) if (!value.ContainsKey(key)) throw new FlowException(3);
        StringField(value, "journeyId", 24, 80);
        StringField(value, "recipientBindingId", 26, 80);
        StringField(value, "senderPolicyId", 30, 80);
        StringField(value, "verificationHost", 3, 253);
        StringField(value, "verificationTenant", 1, 253);
        if (IntegerField(value, "verificationTtlSeconds", 86400, 86400) != 86400)
            throw new FlowException(3);
        IDictionary<string, object> target = value["target"] as IDictionary<string, object>;
        if (target == null || target.Count != 5) throw new FlowException(3);
    }

    private static IDictionary<string, object> ExactObject(string json)
    {
        object parsed = new JavaScriptSerializer { MaxJsonLength = MaximumSection }.DeserializeObject(json);
        IDictionary<string, object> value = parsed as IDictionary<string, object>;
        if (value == null) throw new InvalidDataException();
        return value;
    }

    private static void ExactKeys(IDictionary<string, object> value, string[] keys)
    {
        if (value.Count != keys.Length) throw new InvalidDataException();
        foreach (string key in keys) if (!value.ContainsKey(key)) throw new InvalidDataException();
    }

    private static string StringField(IDictionary<string, object> value, string key, int minimum, int maximum)
    {
        object raw;
        if (!value.TryGetValue(key, out raw)) throw new FlowException(3);
        string text = raw as string;
        if (text == null || text.Length < minimum || text.Length > maximum) throw new FlowException(3);
        return text;
    }

    private static int IntegerField(IDictionary<string, object> value, string key, int minimum, int maximum)
    {
        object raw;
        if (!value.TryGetValue(key, out raw)) throw new FlowException(3);
        if (!(raw is int)) throw new FlowException(3);
        int number = (int)raw;
        if (number < minimum || number > maximum) throw new FlowException(3);
        return number;
    }

    private static DateTimeOffset ExactInstant(string value)
    {
        DateTimeOffset parsed;
        if (!DateTimeOffset.TryParseExact(
            value,
            "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
            out parsed
        )) throw new FlowException(6);
        return parsed;
    }

    private static byte[] ReadHeaders(Stream stream, int bound)
    {
        MemoryStream output = new MemoryStream();
        int matched = 0;
        while (output.Length < bound)
        {
            int next = stream.ReadByte();
            if (next < 0) throw new EndOfStreamException();
            output.WriteByte((byte)next);
            byte expected = new byte[] { 13, 10, 13, 10 }[matched];
            matched = next == expected ? matched + 1 : (next == 13 ? 1 : 0);
            if (matched == 4) return output.ToArray();
        }
        throw new InvalidDataException();
    }

    private static byte[] ReadBounded(Stream stream, int bound)
    {
        MemoryStream output = new MemoryStream();
        byte[] chunk = new byte[4096];
        int count;
        while ((count = stream.Read(chunk, 0, chunk.Length)) > 0)
        {
            if (output.Length + count > bound) throw new InvalidDataException();
            output.Write(chunk, 0, count);
        }
        Clear(chunk);
        return output.ToArray();
    }

    private static string Form(IDictionary<string, string> values)
    {
        List<string> entries = new List<string>();
        foreach (var pair in values)
            entries.Add(HttpUtility.UrlEncode(pair.Key) + "=" + HttpUtility.UrlEncode(pair.Value));
        return String.Join("&", entries.ToArray());
    }

    private static byte[] RandomBytes(int length)
    {
        byte[] value = new byte[length];
        using (RandomNumberGenerator random = RandomNumberGenerator.Create()) random.GetBytes(value);
        return value;
    }

    private static string Base64Url(byte[] value)
    {
        return Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private static string StrictUtf8(byte[] value)
    {
        return new UTF8Encoding(false, true).GetString(value);
    }

    private static bool ValidEmail(string value)
    {
        if (String.IsNullOrWhiteSpace(value) || value.Length > 254) return false;
        int at = value.IndexOf('@');
        return at > 0 && at == value.LastIndexOf('@') && at < value.Length - 1 && value.IndexOfAny(new char[] { ' ', '\r', '\n', '\t' }) < 0;
    }

    private static void WriteOutput(byte[] ciphertext)
    {
        if (ciphertext == null || ciphertext.Length < 1 || ciphertext.Length > MaximumSection)
            throw new InvalidDataException();
        BinaryWriter writer = new BinaryWriter(Console.OpenStandardOutput());
        writer.Write(new byte[] { 72, 65, 71, 83 });
        writer.Write((byte)1);
        writer.Write(ciphertext.Length);
        writer.Write(ciphertext);
        writer.Flush();
    }

    private static void Clear(byte[] value)
    {
        if (value != null) Array.Clear(value, 0, value.Length);
    }
}
'@
try {
  Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Security.dll','System.Web.dll','System.Web.Extensions.dll','Microsoft.VisualBasic.dll'
  exit [HuntInteractiveGmailOAuthSealer]::Run()
} catch { exit 7 }
`;

export interface GmailOAuthSealRequest {
  readonly gmailMetadata: Readonly<Uint8Array>;
  readonly accountMetadata: Readonly<Uint8Array>;
  readonly accountCiphertext: Readonly<Uint8Array>;
  readonly clientId: string;
  readonly installedClientConfigPath: string;
  readonly binding: {
    readonly journeyId: string;
    readonly recipientBindingId: string;
    readonly senderPolicyId: string;
    readonly target: TargetIdentityV1;
    readonly verificationHost: string;
    readonly verificationTenant: string;
    readonly verificationTtlSeconds: 86400;
  };
}

export interface InteractiveGmailOAuthProcess {
  run(input: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
}

export interface WindowsInteractiveGmailOAuthSealerOptions {
  readonly process?: InteractiveGmailOAuthProcess;
  readonly executable?: string;
  readonly maxCiphertextBytes?: number;
  readonly timeoutMs?: number;
}

export class WindowsInteractiveGmailOAuthSealer {
  readonly #process: InteractiveGmailOAuthProcess;
  readonly #bound: number;

  constructor(options: WindowsInteractiveGmailOAuthSealerOptions = {}) {
    this.#bound = options.maxCiphertextBytes ?? DEFAULT_BOUND;
    this.#process = options.process ?? new PowerShellInteractiveGmailOAuthProcess({
      executable: options.executable,
      maxOutputBytes: this.#bound + 9,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  }

  async seal(request: GmailOAuthSealRequest, signal: AbortSignal): Promise<Uint8Array> {
    if (signal.aborted) throw new Error("Gmail OAuth cancelled");
    const sections = encodeSections(request);
    try {
      const framed = await this.#process.run(sections, signal);
      try {
        return parseCiphertext(framed, this.#bound);
      } finally {
        framed.fill(0);
      }
    } catch (error) {
      if (recognized(error)) throw error;
      throw new Error(signal.aborted ? "Gmail OAuth cancelled" : "Gmail OAuth sealing failed");
    } finally {
      sections.fill(0);
    }
  }
}

interface ProcessOptions {
  readonly executable?: string;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
}

class PowerShellInteractiveGmailOAuthProcess implements InteractiveGmailOAuthProcess {
  readonly #executable: string;
  readonly #maxOutputBytes: number;
  readonly #timeoutMs: number;

  constructor(options: ProcessOptions) {
    this.#executable = options.executable ??
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    this.#maxOutputBytes = options.maxOutputBytes;
    this.#timeoutMs = options.timeoutMs;
  }

  run(input: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#executable, [
        "-NoLogo", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass",
        "-Command", INTERACTIVE_GMAIL_OAUTH_SCRIPT,
      ], {
        shell: false,
        windowsHide: false,
        stdio: ["pipe", "pipe", "ignore"],
        env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (error?: Error, value?: Uint8Array) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        for (const chunk of chunks) chunk.fill(0);
        error === undefined ? resolve(value!) : reject(error);
      };
      const cancel = () => {
        child.kill();
        finish(new Error("Gmail OAuth cancelled"));
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error("Gmail OAuth timeout"));
      }, this.#timeoutMs);
      signal.addEventListener("abort", cancel, { once: true });
      child.once("error", () => finish(new Error("Gmail OAuth sealing failed")));
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > this.#maxOutputBytes) {
          chunk.fill(0);
          child.kill();
          finish(new Error("Gmail OAuth sealing failed"));
          return;
        }
        chunks.push(Buffer.from(chunk));
        chunk.fill(0);
      });
      child.once("close", (code) => {
        if (code !== 0) {
          finish(childFailure(code));
          return;
        }
        if (size < 1) {
          finish(new Error("Gmail OAuth sealing failed"));
          return;
        }
        const output = Buffer.concat(chunks);
        const value = new Uint8Array(output);
        output.fill(0);
        finish(undefined, value);
      });
      child.stdin.once("error", () => undefined);
      child.stdin.end(input);
    });
  }
}

function encodeSections(request: GmailOAuthSealRequest): Buffer {
  const binding = Buffer.from(JSON.stringify(request.binding), "utf8");
  const clientId = Buffer.from(request.clientId, "utf8");
  const installedClientConfigPath = Buffer.from(request.installedClientConfigPath, "utf8");
  const values = [
    Buffer.from(request.gmailMetadata),
    Buffer.from(request.accountMetadata),
    Buffer.from(request.accountCiphertext),
    clientId,
    installedClientConfigPath,
    binding,
  ];
  try {
    if (values.some((value) => value.byteLength < 1 || value.byteLength > DEFAULT_BOUND)) {
      throw new Error("Gmail OAuth sealing failed");
    }
    const output = Buffer.allocUnsafe(6 + values.reduce((sum, value) => sum + 4 + value.byteLength, 0));
    INPUT_MAGIC.copy(output, 0);
    output.writeUInt8(1, 4);
    output.writeUInt8(values.length, 5);
    let offset = 6;
    for (const value of values) {
      output.writeUInt32LE(value.byteLength, offset);
      value.copy(output, offset + 4);
      offset += 4 + value.byteLength;
    }
    return output;
  } finally {
    for (const value of values) value.fill(0);
  }
}

function parseCiphertext(value: Uint8Array, bound: number): Uint8Array {
  const input = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (
    input.byteLength < 10 ||
    !input.subarray(0, 4).equals(OUTPUT_MAGIC) ||
    input.readUInt8(4) !== 1
  ) {
    throw new Error("Gmail OAuth sealing failed");
  }
  const length = input.readUInt32LE(5);
  if (length < 1 || length > bound || input.byteLength !== 9 + length) {
    throw new Error("Gmail OAuth sealing failed");
  }
  return new Uint8Array(input.subarray(9));
}

function childFailure(code: number | null): Error {
  const message = code === 2
    ? "Gmail OAuth cancelled"
    : code === 3
      ? "Gmail OAuth denied"
      : code === 4
        ? "Gmail mailbox identity mismatched"
        : code === 5
          ? "Gmail OAuth scope invalid"
          : code === 6
            ? "Gmail OAuth token expiry invalid"
            : code === 8
              ? "Gmail OAuth timeout"
              : code === 9
                ? "Gmail OAuth client invalid"
              : "Gmail OAuth sealing failed";
  return new Error(message);
}

function recognized(error: unknown): error is Error {
  return error instanceof Error && /^Gmail (?:OAuth|mailbox identity)/u.test(error.message);
}
