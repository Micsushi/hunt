import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { TargetIdentityV1 } from "../../../contracts/live/index.ts";

const DEFAULT_BOUND = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const INPUT_MAGIC = Buffer.from("HAGI", "ascii");
const OUTPUT_MAGIC = Buffer.from("HAGS", "ascii");
const REVOKE_INPUT_MAGIC = Buffer.from("HAGR", "ascii");
const REVOKE_OUTPUT_MAGIC = Buffer.from("HAGR", "ascii");
const RECONCILE_INPUT_MAGIC = Buffer.from("HAGC", "ascii");
const RECONCILE_OUTPUT_MAGIC = Buffer.from("HAGC", "ascii");

const INTERACTIVE_GMAIL_OAUTH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Web;
using System.Web.Script.Serialization;

public interface IHuntGmailGrantStore
{
    byte[] Read(string target);
    void Write(string target, byte[] value);
    bool Delete(string target);
}

public interface IHuntGmailOAuthClient
{
    HuntGmailToken AuthorizeInteractive(string clientId, string clientSecret, string loginHint);
    HuntGmailToken Refresh(string clientId, string clientSecret, byte[] refreshValue);
    string ProfileEmail(string accessValue, bool usedExistingGrant);
}

public interface IHuntGmailGrantRevocationClient
{
    void Revoke(byte[] grant);
}

public sealed class HuntGmailRefreshUnavailableException : Exception
{
}

public sealed class HuntGmailToken
{
    public string AccessValue;
    public byte[] RefreshValue;
    public int ExpiresIn;
    public DateTimeOffset ReceivedAt;
    public string ProfileEmail;

    public void Clear()
    {
        if (RefreshValue != null) Array.Clear(RefreshValue, 0, RefreshValue.Length);
        RefreshValue = null;
        AccessValue = null;
        ProfileEmail = null;
    }
}

public static class HuntInteractiveGmailOAuthSealer
{
    private const string Scope = "https://www.googleapis.com/auth/gmail.readonly";
    private const string RevocationEndpoint = "https://oauth2.googleapis.com/revoke";
    private const int MaximumRefreshGrantBytes = 512;
    private const string AuthorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
    private const string InstalledClientAuthUri = "https://accounts.google.com/o/oauth2/auth";
    private const string TokenEndpoint = "https://oauth2.googleapis.com/token";
    private const string CertificateEndpoint = "https://www.googleapis.com/oauth2/v1/certs";
    private const string ProfileEndpoint = "https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress";
    private const int MaximumSection = 1048576;

    private sealed class FlowException : Exception
    {
        public int ExitCode { get; private set; }
        public FlowException(int exitCode) { ExitCode = exitCode; }
    }

    private sealed class WindowsGmailOAuthClient : IHuntGmailOAuthClient
    {
        private readonly string authorizationHandoffPath;

        public WindowsGmailOAuthClient(string path)
        {
            authorizationHandoffPath = path;
        }

        public HuntGmailToken AuthorizeInteractive(
            string clientId,
            string clientSecret,
            string loginHint
        )
        {
            return Authorize(clientId, clientSecret, loginHint, authorizationHandoffPath);
        }

        public HuntGmailToken Refresh(
            string clientId,
            string clientSecret,
            byte[] refreshValue
        )
        {
            return RefreshToken(clientId, clientSecret, refreshValue);
        }

        public string ProfileEmail(string accessValue, bool usedExistingGrant)
        {
            return HuntInteractiveGmailOAuthSealer.ProfileEmail(
                accessValue,
                usedExistingGrant
            );
        }
    }

    private sealed class WindowsGmailGrantRevocationClient : IHuntGmailGrantRevocationClient
    {
        public void Revoke(byte[] grant)
        {
            RevokeToken(grant);
        }
    }

    private sealed class WindowsCredentialManagerGrantStore : IHuntGmailGrantStore
    {
        private const uint GenericCredential = 1;
        private const uint LocalMachinePersistence = 2;
        private const int NotFound = 1168;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct NativeCredential
        {
            public uint Flags;
            public uint Type;
            [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
            [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
            public uint CredentialBlobSize;
            public IntPtr CredentialBlob;
            public uint Persist;
            public uint AttributeCount;
            public IntPtr Attributes;
            [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
            [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
        }

        [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CredRead(
            string target,
            uint type,
            uint flags,
            out IntPtr credential
        );

        [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CredWrite(ref NativeCredential credential, uint flags);

        [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CredDelete(string target, uint type, uint flags);

        [DllImport("advapi32.dll", EntryPoint = "CredFree")]
        private static extern void CredFree(IntPtr credential);

        public byte[] Read(string target)
        {
            ValidateTarget(target);
            IntPtr pointer;
            if (!CredRead(target, GenericCredential, 0, out pointer))
            {
                int error = Marshal.GetLastWin32Error();
                if (error == NotFound) return null;
                throw new Win32Exception(error);
            }
            try
            {
                NativeCredential credential = (NativeCredential)Marshal.PtrToStructure(
                    pointer,
                    typeof(NativeCredential)
                );
                if (credential.Type != GenericCredential ||
                    credential.Persist != LocalMachinePersistence ||
                    !String.Equals(credential.TargetName, target, StringComparison.Ordinal) ||
                    !String.IsNullOrEmpty(credential.Comment) ||
                    credential.AttributeCount != 0 || credential.Attributes != IntPtr.Zero ||
                    !String.IsNullOrEmpty(credential.TargetAlias) ||
                    !String.IsNullOrEmpty(credential.UserName) ||
                    credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize < 1 ||
                    credential.CredentialBlobSize > MaximumRefreshGrantBytes)
                    throw new InvalidDataException();
                byte[] value = new byte[credential.CredentialBlobSize];
                Marshal.Copy(credential.CredentialBlob, value, 0, value.Length);
                if (!ValidGrant(value))
                {
                    Clear(value);
                    throw new InvalidDataException();
                }
                return value;
            }
            finally { CredFree(pointer); }
        }

        public void Write(string target, byte[] value)
        {
            ValidateTarget(target);
            if (!ValidGrant(value)) throw new InvalidDataException();
            IntPtr blob = Marshal.AllocHGlobal(value.Length);
            try
            {
                Marshal.Copy(value, 0, blob, value.Length);
                NativeCredential credential = new NativeCredential {
                    Flags = 0,
                    Type = GenericCredential,
                    TargetName = target,
                    Comment = null,
                    CredentialBlobSize = (uint)value.Length,
                    CredentialBlob = blob,
                    Persist = LocalMachinePersistence,
                    AttributeCount = 0,
                    Attributes = IntPtr.Zero,
                    TargetAlias = null,
                    UserName = null
                };
                if (!CredWrite(ref credential, 0))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            finally
            {
                for (int index = 0; index < value.Length; index++) Marshal.WriteByte(blob, index, 0);
                Marshal.FreeHGlobal(blob);
            }
        }

        public bool Delete(string target)
        {
            ValidateTarget(target);
            if (CredDelete(target, GenericCredential, 0)) return true;
            int error = Marshal.GetLastWin32Error();
            if (error == NotFound) return false;
            throw new Win32Exception(error);
        }

        private static void ValidateTarget(string target)
        {
            const string grantPrefix = "Hunt/C3/GmailRefresh/v1/";
            const string lookupPrefix = "Hunt/C3/GmailRefreshLookup/v1/";
            string prefix = target != null && target.StartsWith(grantPrefix, StringComparison.Ordinal)
                ? grantPrefix
                : target != null && target.StartsWith(lookupPrefix, StringComparison.Ordinal)
                    ? lookupPrefix
                    : null;
            if (prefix == null || target.Length != prefix.Length + 64)
                throw new InvalidDataException();
            for (int index = prefix.Length; index < target.Length; index++)
            {
                char value = target[index];
                if (!((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f')))
                    throw new InvalidDataException();
            }
        }
    }

    public static int Run()
    {
        byte[][] input = null;
        bool revoke = false;
        bool reconcile = false;
        byte[] account = null;
        byte[] bundle = null;
        byte[] framedBundle = null;
        byte[] sealedValue = null;
        HuntGmailToken token = null;
        InstalledClient installedClient = null;
        string sender = null;
        try
        {
            input = ReadInput(out revoke, out reconcile);
            if (revoke)
            {
                WriteRevokeOutput(RevokeFromInput(input));
                return 0;
            }
            if (reconcile)
            {
                WriteReconcileOutput(DeleteFromInput(input));
                return 0;
            }
            account = ProtectedData.Unprotect(input[2], input[1], DataProtectionScope.CurrentUser);
            string accountEmail = ReadAccountEmail(account);
            string clientId = StrictUtf8(input[3]);
            string installedClientConfigPath = StrictUtf8(input[4]);
            string senderPolicyConfigPath = StrictUtf8(input[5]);
            IDictionary<string, object> binding = ExactObject(StrictUtf8(input[6]));
            IDictionary<string, object> gmailMetadata = ExactObject(StrictUtf8(input[0]));
            ValidateClient(clientId);
            ValidateBinding(binding);
            installedClient = ReadInstalledClient(installedClientConfigPath, clientId);
            sender = ReadSenderPolicy(
                senderPolicyConfigPath,
                (string)binding["verificationHost"],
                (string)binding["verificationTenant"]
            );

            token = AcquireTokenWithLookup(
                clientId,
                installedClient.Secret,
                accountEmail,
                (string)binding["recipientBindingId"],
                new WindowsCredentialManagerGrantStore(),
                new WindowsGmailOAuthClient(
                    AuthorizationHandoffPath(installedClientConfigPath)
                )
            );
            ValidateExpiry(gmailMetadata, token.ExpiresIn, token.ReceivedAt);
            string profileEmail = token.ProfileEmail;
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
            framedBundle = FrameBundle(bundle);
            sealedValue = ProtectedData.Protect(framedBundle, input[0], DataProtectionScope.CurrentUser);
            WriteOutput(sealedValue);
            return 0;
        }
        catch (FlowException error) { return error.ExitCode; }
        catch { return 7; }
        finally
        {
            Clear(sealedValue);
            Clear(framedBundle);
            Clear(bundle);
            Clear(account);
            if (token != null) token.Clear();
            if (installedClient != null) installedClient.Clear();
            sender = null;
            if (input != null) foreach (byte[] section in input) Clear(section);
        }
    }

    private static bool RevokeFromInput(byte[][] input)
    {
        InstalledClient installedClient = null;
        try
        {
            string recipientBindingId = StrictUtf8(input[0]);
            string clientId = StrictUtf8(input[1]);
            string installedClientConfigPath = StrictUtf8(input[2]);
            if (!ValidRecipientBindingId(recipientBindingId)) throw new FlowException(11);
            ValidateClient(clientId);
            installedClient = ReadInstalledClient(installedClientConfigPath, clientId);
            return RevokeGrantFromLookup(
                clientId,
                recipientBindingId,
                new WindowsCredentialManagerGrantStore(),
                new WindowsGmailGrantRevocationClient()
            );
        }
        finally
        {
            if (installedClient != null) installedClient.Clear();
        }
    }

    private static bool DeleteFromInput(byte[][] input)
    {
        byte[] account = null;
        InstalledClient installedClient = null;
        Exception failure = null;
        bool deleted = false;
        try
        {
            account = ProtectedData.Unprotect(input[1], input[0], DataProtectionScope.CurrentUser);
            string accountEmail = ReadAccountEmail(account);
            string clientId = StrictUtf8(input[2]);
            string installedClientConfigPath = StrictUtf8(input[3]);
            string recipientBindingId = StrictUtf8(input[4]);
            if (!ValidRecipientBindingId(recipientBindingId)) throw new FlowException(11);
            ValidateClient(clientId);
            installedClient = ReadInstalledClient(installedClientConfigPath, clientId);
            string authorizationHandoffPath = AuthorizationHandoffPath(
                installedClientConfigPath
            );
            try
            {
                deleted = DeleteGrantAndLookup(
                    clientId,
                    accountEmail,
                    recipientBindingId,
                    new WindowsCredentialManagerGrantStore()
                );
            }
            catch (Exception error) { failure = error; }
            try { DeleteAuthorizationHandoffIfPresent(authorizationHandoffPath); }
            catch (Exception error) { if (failure == null) failure = error; }
            if (failure != null) throw failure;
            return deleted;
        }
        finally
        {
            Clear(account);
            if (installedClient != null) installedClient.Clear();
        }
    }

    private static HuntGmailToken AcquireToken(
        string clientId,
        string clientSecret,
        string accountEmail,
        IHuntGmailGrantStore grants,
        IHuntGmailOAuthClient oauth
    )
    {
        string target = GrantTarget(clientId, accountEmail);
        byte[] existing = null;
        HuntGmailToken token = null;
        try
        {
            try { existing = grants.Read(target); }
            catch { throw new FlowException(11); }
            if (existing == null)
            {
                try { token = oauth.AuthorizeInteractive(clientId, clientSecret, accountEmail); }
                catch (FlowException) { throw; }
                catch { throw new FlowException(3); }
                if (token == null || !ValidGrant(token.RefreshValue)) throw new FlowException(3);
            }
            else
            {
                if (!ValidGrant(existing)) throw new FlowException(11);
                try { token = oauth.Refresh(clientId, clientSecret, existing); }
                catch (HuntGmailRefreshUnavailableException) { throw new FlowException(12); }
                catch { throw new FlowException(11); }
                if (token == null) throw new FlowException(11);
            }

            bool usedExistingGrant = existing != null;
            string profileEmail;
            try
            {
                profileEmail = oauth.ProfileEmail(token.AccessValue, usedExistingGrant);
            }
            catch (HuntGmailRefreshUnavailableException) { throw new FlowException(12); }
            catch (FlowException) { throw; }
            catch
            {
                throw new FlowException(usedExistingGrant ? 11 : 4);
            }
            if (!String.Equals(accountEmail, profileEmail, StringComparison.OrdinalIgnoreCase) ||
                !ValidEmail(profileEmail) || profileEmail != profileEmail.ToLowerInvariant())
                throw new FlowException(usedExistingGrant ? 11 : 4);
            token.ProfileEmail = profileEmail;

            if (existing == null || token.RefreshValue != null)
            {
                byte[] value = token.RefreshValue;
                if (!ValidGrant(value))
                    throw new FlowException(existing == null ? 3 : 11);
                try { grants.Write(target, value); }
                catch
                {
                    try { grants.Delete(target); } catch { }
                    throw new FlowException(11);
                }
            }
            return token;
        }
        catch
        {
            if (token != null) token.Clear();
            throw;
        }
        finally
        {
            Clear(existing);
            clientSecret = null;
            accountEmail = null;
            target = null;
        }
    }

    private static HuntGmailToken AcquireTokenWithLookup(
        string clientId,
        string clientSecret,
        string accountEmail,
        string recipientBindingId,
        IHuntGmailGrantStore grants,
        IHuntGmailOAuthClient oauth
    )
    {
        if (!ValidRecipientBindingId(recipientBindingId)) throw new FlowException(11);
        string grantTarget = GrantTarget(clientId, accountEmail);
        HuntGmailToken token = null;
        try
        {
            token = AcquireToken(clientId, clientSecret, accountEmail, grants, oauth);
            EnsureGrantLookup(clientId, recipientBindingId, grantTarget, grants);
            return token;
        }
        catch
        {
            if (token != null) token.Clear();
            throw;
        }
        finally
        {
            accountEmail = null;
            recipientBindingId = null;
            grantTarget = null;
        }
    }

    private static void EnsureGrantLookup(
        string clientId,
        string recipientBindingId,
        string grantTarget,
        IHuntGmailGrantStore grants
    )
    {
        string lookupTarget = LookupTarget(clientId, recipientBindingId);
        string locator = GrantLocatorFromTarget(grantTarget);
        byte[] expected = Encoding.ASCII.GetBytes(locator);
        byte[] existing = null;
        try
        {
            try { existing = grants.Read(lookupTarget); }
            catch
            {
                DeleteExactGrantAndLookup(grantTarget, lookupTarget, grants);
                throw new FlowException(11);
            }
            if (existing == null)
            {
                try { grants.Write(lookupTarget, expected); }
                catch
                {
                    DeleteExactGrantAndLookup(grantTarget, lookupTarget, grants);
                    throw new FlowException(11);
                }
                try { existing = grants.Read(lookupTarget); }
                catch
                {
                    DeleteExactGrantAndLookup(grantTarget, lookupTarget, grants);
                    throw new FlowException(11);
                }
            }
            if (!ValidLocator(existing) || !FixedEquals(existing, expected))
            {
                DeleteExactGrantAndLookup(grantTarget, lookupTarget, grants);
                throw new FlowException(11);
            }
        }
        finally
        {
            Clear(existing);
            Clear(expected);
            clientId = null;
            recipientBindingId = null;
            grantTarget = null;
            lookupTarget = null;
            locator = null;
        }
    }

    private static bool RevokeGrantFromLookup(
        string clientId,
        string recipientBindingId,
        IHuntGmailGrantStore grants,
        IHuntGmailGrantRevocationClient revoker
    )
    {
        string lookupTarget = LookupTarget(clientId, recipientBindingId);
        string grantTarget = null;
        byte[] locator = null;
        byte[] grant = null;
        try
        {
            try { locator = grants.Read(lookupTarget); }
            catch
            {
                try { grants.Delete(lookupTarget); } catch { }
                throw new FlowException(11);
            }
            if (locator == null) return false;
            if (!ValidLocator(locator))
            {
                grants.Delete(lookupTarget);
                throw new FlowException(11);
            }
            grantTarget = GrantTargetFromLocator(StrictUtf8(locator));
            try { grant = grants.Read(grantTarget); }
            catch
            {
                DeleteExactGrantAndLookup(grantTarget, lookupTarget, grants);
                throw new FlowException(11);
            }
            if (grant == null)
            {
                grants.Delete(lookupTarget);
                throw new FlowException(11);
            }
            if (!ValidGrant(grant))
            {
                DeleteExactGrantAndLookup(grantTarget, lookupTarget, grants);
                throw new FlowException(11);
            }
            try { revoker.Revoke(grant); }
            catch (HuntGmailRefreshUnavailableException) { throw new FlowException(12); }
            catch { throw new FlowException(11); }
            DeleteExactGrantAndLookup(grantTarget, lookupTarget, grants);
            return true;
        }
        finally
        {
            Clear(grant);
            Clear(locator);
            clientId = null;
            recipientBindingId = null;
            grantTarget = null;
            lookupTarget = null;
        }
    }

    private static bool DeleteGrantAndLookup(
        string clientId,
        string accountEmail,
        string recipientBindingId,
        IHuntGmailGrantStore grants
    )
    {
        string grantTarget = GrantTarget(clientId, accountEmail);
        string lookupTarget = LookupTarget(clientId, recipientBindingId);
        try { return DeleteExactGrantAndLookup(grantTarget, lookupTarget, grants); }
        finally
        {
            accountEmail = null;
            recipientBindingId = null;
            grantTarget = null;
            lookupTarget = null;
        }
    }

    private static bool DeleteExactGrantAndLookup(
        string grantTarget,
        string lookupTarget,
        IHuntGmailGrantStore grants
    )
    {
        bool deleted = false;
        Exception failure = null;
        try { deleted = grants.Delete(grantTarget); }
        catch (Exception error) { failure = error; }
        try { deleted = grants.Delete(lookupTarget) || deleted; }
        catch (Exception error) { if (failure == null) failure = error; }
        if (failure != null) throw new FlowException(11);
        return deleted;
    }

    private static bool FixedEquals(byte[] left, byte[] right)
    {
        if (left == null || right == null || left.Length != right.Length) return false;
        int difference = 0;
        for (int index = 0; index < left.Length; index++) difference |= left[index] ^ right[index];
        return difference == 0;
    }

    private static bool RevokeGrant(
        string clientId,
        string accountEmail,
        IHuntGmailGrantStore grants,
        IHuntGmailGrantRevocationClient revoker
    )
    {
        string target = GrantTarget(clientId, accountEmail);
        byte[] grant = null;
        try
        {
            try { grant = grants.Read(target); }
            catch (InvalidDataException) { throw new FlowException(11); }
            if (grant == null) return false;
            if (!ValidGrant(grant)) throw new FlowException(11);
            try { revoker.Revoke(grant); }
            catch (HuntGmailRefreshUnavailableException) { throw new FlowException(12); }
            catch { throw new FlowException(11); }
            grants.Delete(target);
            return true;
        }
        finally
        {
            Clear(grant);
            accountEmail = null;
            target = null;
        }
    }

    private static bool DeleteGrant(
        string clientId,
        string accountEmail,
        IHuntGmailGrantStore grants
    )
    {
        string target = GrantTarget(clientId, accountEmail);
        try { return grants.Delete(target); }
        finally
        {
            accountEmail = null;
            target = null;
        }
    }

    private static string GrantTarget(string clientId, string accountEmail)
    {
        ValidateClient(clientId);
        if (!ValidEmail(accountEmail)) throw new FlowException(3);
        string normalized = accountEmail.ToLowerInvariant();
        byte[] binding = Encoding.UTF8.GetBytes(
            "hunt-c3-gmail-refresh-grant-v1\0" + clientId + "\0" + normalized +
            "\0" + Scope
        );
        byte[] digest = null;
        try
        {
            using (SHA256 algorithm = SHA256.Create()) digest = algorithm.ComputeHash(binding);
            StringBuilder target = new StringBuilder("Hunt/C3/GmailRefresh/v1/", 90);
            foreach (byte value in digest) target.Append(value.ToString("x2", CultureInfo.InvariantCulture));
            return target.ToString();
        }
        finally
        {
            Clear(digest);
            Clear(binding);
            normalized = null;
            accountEmail = null;
        }
    }

    private static string LookupTarget(string clientId, string recipientBindingId)
    {
        ValidateClient(clientId);
        if (!ValidRecipientBindingId(recipientBindingId)) throw new FlowException(11);
        byte[] binding = Encoding.UTF8.GetBytes(
            "hunt-c3-gmail-refresh-lookup-v1\0" + clientId + "\0" + recipientBindingId +
            "\0" + Scope
        );
        byte[] digest = null;
        try
        {
            using (SHA256 algorithm = SHA256.Create()) digest = algorithm.ComputeHash(binding);
            StringBuilder target = new StringBuilder("Hunt/C3/GmailRefreshLookup/v1/", 96);
            foreach (byte value in digest) target.Append(value.ToString("x2", CultureInfo.InvariantCulture));
            return target.ToString();
        }
        finally
        {
            Clear(digest);
            Clear(binding);
            recipientBindingId = null;
        }
    }

    private static string GrantLocatorFromTarget(string target)
    {
        const string prefix = "Hunt/C3/GmailRefresh/v1/";
        if (target == null || !target.StartsWith(prefix, StringComparison.Ordinal) ||
            target.Length != prefix.Length + 64)
            throw new FlowException(11);
        string locator = target.Substring(prefix.Length);
        if (!ValidLocator(locator)) throw new FlowException(11);
        return locator;
    }

    private static string GrantTargetFromLocator(string locator)
    {
        if (!ValidLocator(locator)) throw new FlowException(11);
        return "Hunt/C3/GmailRefresh/v1/" + locator;
    }

    private static bool ValidLocator(byte[] value)
    {
        if (value == null || value.Length != 64) return false;
        try { return ValidLocator(Encoding.ASCII.GetString(value)); }
        catch { return false; }
    }

    private static bool ValidLocator(string value)
    {
        if (value == null || value.Length != 64) return false;
        foreach (char character in value)
            if (!((character >= '0' && character <= '9') ||
                (character >= 'a' && character <= 'f'))) return false;
        return true;
    }

    private static bool ValidRecipientBindingId(string value)
    {
        const string prefix = "recipient_";
        if (value == null || !value.StartsWith(prefix, StringComparison.Ordinal) ||
            value.Length < prefix.Length + 16 || value.Length > prefix.Length + 64)
            return false;
        for (int index = prefix.Length; index < value.Length; index++)
        {
            char character = value[index];
            if (!((character >= 'A' && character <= 'Z') ||
                (character >= 'a' && character <= 'z') ||
                (character >= '0' && character <= '9') || character == '_' || character == '-'))
                return false;
        }
        return true;
    }

    private static bool ValidGrant(byte[] value)
    {
        if (value == null || value.Length < 1 ||
            value.Length > MaximumRefreshGrantBytes) return false;
        try
        {
            string text = StrictUtf8(value);
            if (text.Length < 1 || text.Length > MaximumRefreshGrantBytes) return false;
            foreach (char character in text)
                if (Char.IsControl(character) || Char.IsWhiteSpace(character)) return false;
            return true;
        }
        catch { return false; }
    }

    private static byte[][] ReadInput(out bool revoke, out bool reconcile)
    {
        BinaryReader reader = new BinaryReader(Console.OpenStandardInput());
        byte[] magic = reader.ReadBytes(4);
        if (magic.Length != 4 || magic[0] != 72 || magic[1] != 65 || magic[2] != 71 ||
            (magic[3] != 73 && magic[3] != 82 && magic[3] != 67))
            throw new InvalidDataException();
        revoke = magic[3] == 82;
        reconcile = magic[3] == 67;
        int count = revoke ? 3 : reconcile ? 5 : 7;
        if (reader.ReadByte() != 1 || reader.ReadByte() != count) throw new InvalidDataException();
        byte[][] sections = new byte[count][];
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
            if (StringField(installed, "auth_uri", InstalledClientAuthUri.Length, InstalledClientAuthUri.Length) != InstalledClientAuthUri ||
                StringField(installed, "token_uri", TokenEndpoint.Length, TokenEndpoint.Length) != TokenEndpoint ||
                StringField(installed, "auth_provider_x509_cert_url", CertificateEndpoint.Length, CertificateEndpoint.Length) != CertificateEndpoint)
                throw new InvalidDataException();
            ValidateProjectId(StringField(installed, "project_id", 6, 30));
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

    private static void ValidateProjectId(string value)
    {
        if (value.Length < 6 || value.Length > 30 || value[0] < 'a' || value[0] > 'z')
            throw new InvalidDataException();
        char last = value[value.Length - 1];
        if (!((last >= 'a' && last <= 'z') || (last >= '0' && last <= '9')))
            throw new InvalidDataException();
        foreach (char character in value)
            if (!((character >= 'a' && character <= 'z') ||
                (character >= '0' && character <= '9') || character == '-'))
                throw new InvalidDataException();
    }

    private static string ReadSenderPolicy(string path, string expectedHost, string expectedTenant)
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
            IDictionary<string, object> policy = ExactObject(StrictUtf8(bytes));
            ExactKeys(policy, new string[] {
                "schemaVersion", "contractRevision", "senderAddress",
                "verificationHost", "verificationTenant"
            });
            if (IntegerField(policy, "schemaVersion", 1, 1) != 1 ||
                StringField(policy, "contractRevision", 25, 25) != "s2-gmail-sender-policy-v2" ||
                StringField(policy, "verificationHost", 3, 253) != expectedHost ||
                StringField(policy, "verificationTenant", 1, 253) != expectedTenant)
                throw new InvalidDataException();
            string sender = StringField(policy, "senderAddress", 3, 254);
            if (!ValidEmail(sender) || sender != sender.ToLowerInvariant())
                throw new InvalidDataException();
            return sender;
        }
        catch { throw new FlowException(10); }
        finally { Clear(bytes); }
    }

    private static HuntGmailToken Authorize(
        string clientId,
        string clientSecret,
        string loginHint,
        string authorizationHandoffPath
    )
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
        bool handoffCreated = false;
        try
        {
            listener.Start(1);
            int port = ((IPEndPoint)listener.LocalEndpoint).Port;
            string redirect = "http://127.0.0.1:" + port + "/oauth2callback";
            string authorization = AuthorizationUrl(clientId, redirect, state, challenge, loginHint);
            WriteAuthorizationHandoff(authorizationHandoffPath, authorization);
            handoffCreated = true;
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
                65536,
                false
            );
            HuntGmailToken token = ParseTokenResponse(response, true, receivedAt);
            code = null;
            verifier = null;
            state = null;
            challenge = null;
            return token;
        }
        finally
        {
            clientSecret = null;
            loginHint = null;
            listener.Stop();
            if (handoffCreated) DeleteAuthorizationHandoff(authorizationHandoffPath);
        }
    }

    private static string AuthorizationHandoffPath(string installedClientConfigPath)
    {
        string directory = Path.GetDirectoryName(installedClientConfigPath);
        if (String.IsNullOrWhiteSpace(directory) ||
            !String.Equals(Path.GetFullPath(directory), directory, StringComparison.OrdinalIgnoreCase))
            throw new FlowException(9);
        DirectoryInfo info = new DirectoryInfo(directory);
        if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new FlowException(9);
        ValidateAuthorizationDirectory(directory);
        return Path.Combine(directory, "gmail-oauth-authorization.url");
    }

    private static void ValidateAuthorizationDirectory(string directory)
    {
        try
        {
            SecurityIdentifier current = WindowsIdentity.GetCurrent().User;
            SecurityIdentifier system = new SecurityIdentifier("S-1-5-18");
            DirectorySecurity security = Directory.GetAccessControl(
                directory,
                AccessControlSections.Access | AccessControlSections.Owner
            );
            SecurityIdentifier owner = (SecurityIdentifier)security.GetOwner(
                typeof(SecurityIdentifier)
            );
            if (!owner.Equals(current) || !security.AreAccessRulesProtected)
                throw new InvalidDataException();
            bool currentFullControl = false;
            AuthorizationRuleCollection rules = security.GetAccessRules(
                true,
                true,
                typeof(SecurityIdentifier)
            );
            foreach (FileSystemAccessRule rule in rules)
            {
                if (rule.AccessControlType != AccessControlType.Allow) continue;
                SecurityIdentifier identity = (SecurityIdentifier)rule.IdentityReference;
                if (rule.IsInherited || (!identity.Equals(current) && !identity.Equals(system)))
                    throw new InvalidDataException();
                if (identity.Equals(current) &&
                    (rule.FileSystemRights & FileSystemRights.FullControl) == FileSystemRights.FullControl)
                    currentFullControl = true;
            }
            if (!currentFullControl) throw new InvalidDataException();
        }
        catch { throw new FlowException(9); }
    }

    private static void WriteAuthorizationHandoff(string path, string authorization)
    {
        byte[] bytes = null;
        try
        {
            if (String.IsNullOrWhiteSpace(path) ||
                !String.Equals(Path.GetFullPath(path), path, StringComparison.OrdinalIgnoreCase) ||
                String.IsNullOrWhiteSpace(authorization) ||
                !authorization.StartsWith(AuthorizationEndpoint + "?", StringComparison.Ordinal) ||
                authorization.IndexOfAny(new char[] { '\r', '\n', '\0' }) >= 0)
                throw new FlowException(3);
            if (File.Exists(path)) throw new FlowException(13);
            bytes = Encoding.ASCII.GetBytes(
                "[InternetShortcut]\r\nURL=" + authorization + "\r\n"
            );
            SecurityIdentifier current = WindowsIdentity.GetCurrent().User;
            SecurityIdentifier system = new SecurityIdentifier("S-1-5-18");
            FileSecurity acl = new FileSecurity();
            acl.SetOwner(current);
            acl.SetAccessRuleProtection(true, false);
            acl.AddAccessRule(new FileSystemAccessRule(
                current,
                FileSystemRights.FullControl,
                AccessControlType.Allow
            ));
            acl.AddAccessRule(new FileSystemAccessRule(
                system,
                FileSystemRights.FullControl,
                AccessControlType.Allow
            ));
            using (FileStream stream = new FileStream(
                path,
                FileMode.CreateNew,
                FileSystemRights.Write,
                FileShare.None,
                4096,
                FileOptions.WriteThrough,
                acl
            ))
            {
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
            }
        }
        catch (FlowException) { throw; }
        catch (IOException)
        {
            if (File.Exists(path)) throw new FlowException(13);
            throw new FlowException(3);
        }
        catch { throw new FlowException(3); }
        finally { Clear(bytes); }
    }

    private static void DeleteAuthorizationHandoffIfPresent(string path)
    {
        if (File.Exists(path)) DeleteAuthorizationHandoff(path);
    }

    private static void DeleteAuthorizationHandoff(string path)
    {
        try
        {
            FileInfo info = new FileInfo(path);
            if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0 ||
                info.Length < 32 || info.Length > 16384)
                throw new InvalidDataException();
            File.Delete(path);
            if (File.Exists(path)) throw new IOException();
        }
        catch { throw new FlowException(3); }
    }

    private static HuntGmailToken RefreshToken(
        string clientId,
        string clientSecret,
        byte[] refreshValue
    )
    {
        if (!ValidGrant(refreshValue)) throw new FlowException(11);
        string refresh = null;
        try
        {
            refresh = StrictUtf8(refreshValue);
            DateTimeOffset receivedAt = DateTimeOffset.UtcNow;
            IDictionary<string, object> response = RequestJson(
                TokenEndpoint,
                "POST",
                Form(new Dictionary<string, string> {
                    { "client_id", clientId }, { "client_secret", clientSecret },
                    { "refresh_token", refresh }, { "grant_type", "refresh_token" }
                }),
                null,
                65536,
                true
            );
            return ParseTokenResponse(response, false, receivedAt);
        }
        catch (HuntGmailRefreshUnavailableException) { throw; }
        catch { throw new FlowException(11); }
        finally
        {
            refresh = null;
            clientSecret = null;
        }
    }

    private static void RevokeToken(byte[] grant)
    {
        if (!ValidGrant(grant)) throw new FlowException(11);
        string token = null;
        byte[] payload = null;
        try
        {
            token = StrictUtf8(grant);
            payload = Encoding.UTF8.GetBytes(Form(new Dictionary<string, string> {
                { "token", token }
            }));
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(RevocationEndpoint);
            request.Method = "POST";
            request.AllowAutoRedirect = false;
            request.Timeout = 30000;
            request.ReadWriteTimeout = 30000;
            request.Accept = "application/json";
            request.ContentType = "application/x-www-form-urlencoded";
            request.ContentLength = payload.Length;
            try
            {
                using (Stream stream = request.GetRequestStream())
                    stream.Write(payload, 0, payload.Length);
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    if (response.StatusCode != HttpStatusCode.OK)
                    {
                        if (RefreshResponseUnavailable(
                            WebExceptionStatus.ProtocolError,
                            (int)response.StatusCode
                        )) throw new HuntGmailRefreshUnavailableException();
                        throw new FlowException(11);
                    }
                    byte[] responseBytes = ReadBounded(response.GetResponseStream(), 4096);
                    Clear(responseBytes);
                }
            }
            catch (WebException error)
            {
                HttpWebResponse response = error.Response as HttpWebResponse;
                int statusCode = response == null ? 0 : (int)response.StatusCode;
                try
                {
                    if (RefreshResponseUnavailable(error.Status, statusCode))
                        throw new HuntGmailRefreshUnavailableException();
                    if (response != null && ProviderInvalidToken(response)) return;
                    throw new FlowException(11);
                }
                finally { if (response != null) response.Close(); }
            }
        }
        finally
        {
            Clear(payload);
            token = null;
        }
    }

    private static bool ProviderInvalidToken(HttpWebResponse response)
    {
        if (response.StatusCode != HttpStatusCode.BadRequest ||
            response.ContentType == null ||
            !response.ContentType.StartsWith("application/json", StringComparison.OrdinalIgnoreCase))
            return false;
        byte[] bytes = ReadBounded(response.GetResponseStream(), 4096);
        try
        {
            IDictionary<string, object> value = ExactObject(StrictUtf8(bytes));
            return ExactProviderInvalidToken(value);
        }
        catch { return false; }
        finally { Clear(bytes); }
    }

    private static bool ExactProviderInvalidToken(IDictionary<string, object> value)
    {
        try
        {
            ExactKeys(value, new string[] { "error" });
            return StringField(value, "error", 13, 13) == "invalid_token";
        }
        catch { return false; }
    }

    private static HuntGmailToken ParseTokenResponse(
        IDictionary<string, object> response,
        bool requireRefresh,
        DateTimeOffset receivedAt
    )
    {
        bool hasRefresh = response != null && response.ContainsKey("refresh_token");
        bool hasRefreshExpiry = response != null &&
            response.ContainsKey("refresh_token_expires_in");
        string[] keys = hasRefresh
            ? hasRefreshExpiry
                ? new string[] { "access_token", "expires_in", "refresh_token", "refresh_token_expires_in", "scope", "token_type" }
                : new string[] { "access_token", "expires_in", "refresh_token", "scope", "token_type" }
            : hasRefreshExpiry
                ? new string[] { "access_token", "expires_in", "refresh_token_expires_in", "scope", "token_type" }
                : new string[] { "access_token", "expires_in", "scope", "token_type" };
        if (response == null || (requireRefresh && !hasRefresh)) throw new FlowException(3);
        ExactKeys(response, keys);
        string access = StringField(response, "access_token", 1, 4096);
        if (!ValidTokenText(access)) throw new FlowException(3);
        if (StringField(response, "token_type", 6, 16) != "Bearer")
            throw new FlowException(3);
        if (StringField(response, "scope", Scope.Length, Scope.Length) != Scope)
            throw new FlowException(5);
        int expires = IntegerField(response, "expires_in", 120, 7200);
        if (hasRefreshExpiry)
            IntegerField(response, "refresh_token_expires_in", 1, 31536000);
        byte[] refresh = null;
        try
        {
            if (hasRefresh)
            {
                string raw = StringField(
                    response,
                    "refresh_token",
                    1,
                    MaximumRefreshGrantBytes
                );
                if (!ValidTokenText(raw)) throw new FlowException(3);
                refresh = new UTF8Encoding(false, true).GetBytes(raw);
                if (!ValidGrant(refresh)) throw new FlowException(3);
                raw = null;
            }
            HuntGmailToken token = new HuntGmailToken {
                AccessValue = access,
                RefreshValue = refresh,
                ExpiresIn = expires,
                ReceivedAt = receivedAt
            };
            refresh = null;
            return token;
        }
        finally { Clear(refresh); }
    }

    private static bool ValidTokenText(string value)
    {
        if (String.IsNullOrEmpty(value)) return false;
        foreach (char character in value)
            if (Char.IsControl(character) || Char.IsWhiteSpace(character)) return false;
        return true;
    }

    private static string AuthorizationUrl(
        string clientId,
        string redirect,
        string state,
        string challenge,
        string loginHint
    )
    {
        if (!ValidEmail(loginHint)) throw new FlowException(3);
        return AuthorizationEndpoint + "?" + Form(new Dictionary<string, string> {
            { "client_id", clientId }, { "redirect_uri", redirect },
            { "response_type", "code" }, { "scope", Scope }, { "state", state },
            { "code_challenge", challenge }, { "code_challenge_method", "S256" },
            { "login_hint", loginHint }, { "access_type", "offline" },
            { "prompt", "consent" }
        });
    }

    private static string ReceiveCode(TcpListener listener, int port, string state)
    {
        IAsyncResult pending = listener.BeginAcceptTcpClient(null, null);
        if (!pending.AsyncWaitHandle.WaitOne(TimeSpan.FromSeconds(210))) throw new FlowException(8);
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

    private static string ProfileEmail(string access, bool usedExistingGrant)
    {
        IDictionary<string, object> profile = RequestJson(
            ProfileEndpoint,
            "GET",
            null,
            "Bearer " + access,
            16384,
            usedExistingGrant
        );
        return StringField(profile, "emailAddress", 3, 254);
    }

    private static IDictionary<string, object> RequestJson(
        string url,
        string method,
        string body,
        string authorization,
        int bound,
        bool refreshRequest)
    {
        ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
        request.Method = method;
        request.AllowAutoRedirect = false;
        request.Timeout = 30000;
        request.ReadWriteTimeout = 30000;
        request.Accept = "application/json";
        if (authorization != null) request.Headers[HttpRequestHeader.Authorization] = authorization;
        try
        {
            if (body != null)
            {
                byte[] payload = Encoding.UTF8.GetBytes(body);
                try
                {
                    request.ContentType = "application/x-www-form-urlencoded";
                    request.ContentLength = payload.Length;
                    using (Stream stream = request.GetRequestStream())
                        stream.Write(payload, 0, payload.Length);
                }
                finally { Clear(payload); }
            }
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            {
                if (response.StatusCode != HttpStatusCode.OK)
                {
                    if (refreshRequest && RefreshResponseUnavailable(
                        WebExceptionStatus.ProtocolError,
                        (int)response.StatusCode
                    )) throw new HuntGmailRefreshUnavailableException();
                    throw new FlowException(3);
                }
                if (response.ContentType == null || !response.ContentType.StartsWith("application/json", StringComparison.OrdinalIgnoreCase))
                    throw new FlowException(3);
                byte[] bytes = ReadBounded(response.GetResponseStream(), bound);
                try { return ExactObject(StrictUtf8(bytes)); }
                finally { Clear(bytes); }
            }
        }
        catch (WebException error)
        {
            HttpWebResponse response = error.Response as HttpWebResponse;
            int statusCode = response == null ? 0 : (int)response.StatusCode;
            if (response != null) response.Close();
            if (refreshRequest && RefreshResponseUnavailable(error.Status, statusCode))
                throw new HuntGmailRefreshUnavailableException();
            throw new FlowException(3);
        }
    }

    private static bool RefreshResponseUnavailable(
        WebExceptionStatus status,
        int httpStatus
    )
    {
        if (status != WebExceptionStatus.ProtocolError) return true;
        return httpStatus == 408 || httpStatus == 429 ||
            (httpStatus >= 500 && httpStatus <= 599);
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

    private static void WriteRevokeOutput(bool revoked)
    {
        BinaryWriter writer = new BinaryWriter(Console.OpenStandardOutput());
        writer.Write(new byte[] { 72, 65, 71, 82 });
        writer.Write((byte)1);
        writer.Write((byte)(revoked ? 1 : 0));
        writer.Flush();
    }

    private static void WriteReconcileOutput(bool removed)
    {
        BinaryWriter writer = new BinaryWriter(Console.OpenStandardOutput());
        writer.Write(new byte[] { 72, 65, 71, 67 });
        writer.Write((byte)1);
        writer.Write((byte)(removed ? 1 : 0));
        writer.Flush();
    }

    private static byte[] FrameBundle(byte[] bundle)
    {
        if (bundle == null || bundle.Length < 1 || bundle.Length > MaximumSection - 8)
            throw new InvalidDataException();
        byte[] output = new byte[8 + bundle.Length];
        output[0] = 1;
        output[4] = (byte)bundle.Length;
        output[5] = (byte)(bundle.Length >> 8);
        output[6] = (byte)(bundle.Length >> 16);
        output[7] = (byte)(bundle.Length >> 24);
        Buffer.BlockCopy(bundle, 0, output, 8, bundle.Length);
        return output;
    }

    private static void Clear(byte[] value)
    {
        if (value != null) Array.Clear(value, 0, value.Length);
    }
}
'@
try {
  Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Security.dll','System.Web.dll','System.Web.Extensions.dll'
  exit [HuntInteractiveGmailOAuthSealer]::Run()
} catch { exit 7 }
`;

const INTERACTIVE_GMAIL_OAUTH_SOURCE = trustedHelperSourcePath();
const INTERACTIVE_GMAIL_OAUTH_SHA256 = createHash("sha256")
  .update(INTERACTIVE_GMAIL_OAUTH_SCRIPT, "utf8")
  .digest("hex");
const INTERACTIVE_GMAIL_OAUTH_LAUNCHER = String.raw`
$ErrorActionPreference = 'Stop'
$bytes = $null
$hashBytes = $null
$scriptBytes = $null
$sha256 = $null
try {
    $sourcePath = $env:HUNT_GMAIL_HELPER_SOURCE
    $expectedSha256 = $env:HUNT_GMAIL_HELPER_SHA256
    if (
        -not [System.IO.Path]::IsPathRooted($sourcePath) -or
        $expectedSha256 -notmatch '^[0-9a-f]{64}$'
    ) { exit 7 }
    $item = Get-Item -LiteralPath $sourcePath -Force
    if (
        $item.PSIsContainer -or
        (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -or
        $item.Length -lt 10000 -or
        $item.Length -gt 131072
    ) { exit 7 }
    $bytes = [System.IO.File]::ReadAllBytes($sourcePath)
    if (
        $bytes.Length -ne $item.Length -or
        ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191)
    ) { exit 7 }
    $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
    $typescript = $utf8.GetString($bytes)
    $prefix = 'const INTERACTIVE_GMAIL_OAUTH_SCRIPT = String.raw' + [char]96
    $suffix = [string][char]96 + ';'
    $start = $typescript.IndexOf($prefix, [System.StringComparison]::Ordinal)
    if ($start -lt 0 -or $typescript.LastIndexOf($prefix, [System.StringComparison]::Ordinal) -ne $start) {
        exit 7
    }
    $start += $prefix.Length
    $end = $typescript.IndexOf($suffix, $start, [System.StringComparison]::Ordinal)
    if ($end -lt $start) { exit 7 }
    $script = $typescript.Substring($start, $end - $start)
    $scriptBytes = $utf8.GetBytes($script)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $hashBytes = $sha256.ComputeHash($scriptBytes)
    $actualSha256 = [System.BitConverter]::ToString($hashBytes).Replace('-', '').ToLowerInvariant()
    if ($actualSha256 -cne $expectedSha256) { exit 7 }
    Invoke-Expression $script
} catch { exit 7 }
finally {
    if ($null -ne $hashBytes) { [System.Array]::Clear($hashBytes, 0, $hashBytes.Length) }
    if ($null -ne $scriptBytes) { [System.Array]::Clear($scriptBytes, 0, $scriptBytes.Length) }
    if ($null -ne $bytes) { [System.Array]::Clear($bytes, 0, $bytes.Length) }
    if ($null -ne $sha256) { $sha256.Dispose() }
}
`;

export interface GmailOAuthSealRequest {
  readonly gmailMetadata: Readonly<Uint8Array>;
  readonly accountMetadata: Readonly<Uint8Array>;
  readonly accountCiphertext: Readonly<Uint8Array>;
  readonly clientId: string;
  readonly installedClientConfigPath: string;
  readonly senderPolicyConfigPath: string;
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
  reconcile(input: Uint8Array): Promise<void>;
}

export interface WindowsInteractiveGmailOAuthSealerOptions {
  readonly process?: InteractiveGmailOAuthProcess;
  readonly executable?: string;
  readonly maxCiphertextBytes?: number;
  readonly timeoutMs?: number;
}

export interface GmailRefreshGrantRevokeRequest {
  readonly recipientBindingId: string;
  readonly clientId: string;
  readonly installedClientConfigPath: string;
}

export interface WindowsGmailRefreshGrantRevokerOptions {
  readonly process?: InteractiveGmailOAuthProcess;
  readonly executable?: string;
  readonly timeoutMs?: number;
}

export class WindowsGmailRefreshGrantRevoker {
  readonly #process: InteractiveGmailOAuthProcess;

  constructor(options: WindowsGmailRefreshGrantRevokerOptions = {}) {
    this.#process = options.process ?? new PowerShellInteractiveGmailOAuthProcess({
      executable: options.executable,
      maxOutputBytes: 6,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      windowsHide: true,
    });
  }

  async revoke(
    request: GmailRefreshGrantRevokeRequest,
    signal: AbortSignal,
  ): Promise<"revoked" | "absent"> {
    if (signal.aborted) throw new Error("Gmail OAuth cancelled");
    const sections = encodeRevokeSections(request);
    try {
      const framed = await this.#process.run(sections, signal);
      try {
        return parseRevokeResult(framed);
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

export class WindowsInteractiveGmailOAuthSealer {
  readonly #process: InteractiveGmailOAuthProcess;
  readonly #bound: number;

  constructor(options: WindowsInteractiveGmailOAuthSealerOptions = {}) {
    this.#bound = options.maxCiphertextBytes ?? DEFAULT_BOUND;
    this.#process = options.process ?? new PowerShellInteractiveGmailOAuthProcess({
      executable: options.executable,
      maxOutputBytes: this.#bound + 9,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      windowsHide: true,
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
      if (requiresReconciliation(error)) {
        const reconciliation = encodeReconcileSections(request);
        try {
          await this.#process.reconcile(reconciliation);
        } catch {
          throw new Error("Gmail OAuth reconciliation failed");
        } finally {
          reconciliation.fill(0);
        }
      }
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
  readonly windowsHide: boolean;
}

class PowerShellInteractiveGmailOAuthProcess implements InteractiveGmailOAuthProcess {
  readonly #executable: string;
  readonly #maxOutputBytes: number;
  readonly #timeoutMs: number;
  readonly #windowsHide: boolean;

  constructor(options: ProcessOptions) {
    this.#executable = options.executable ??
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    this.#maxOutputBytes = options.maxOutputBytes;
    this.#timeoutMs = options.timeoutMs;
    this.#windowsHide = options.windowsHide;
  }

  run(input: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
    return this.#run(input, signal, this.#maxOutputBytes, this.#windowsHide, this.#timeoutMs);
  }

  async reconcile(input: Uint8Array): Promise<void> {
    const output = await this.#run(input, new AbortController().signal, 6, true, 10_000);
    try {
      parseReconcileResult(output);
    } finally {
      output.fill(0);
    }
  }

  #run(
    input: Uint8Array,
    signal: AbortSignal,
    maxOutputBytes: number,
    windowsHide: boolean,
    timeoutMs: number,
  ): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#executable, [
        "-NoLogo", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass",
        "-Command", INTERACTIVE_GMAIL_OAUTH_LAUNCHER,
      ], {
        shell: false,
        windowsHide,
        stdio: ["pipe", "pipe", "ignore"],
        env: {
          SystemRoot: "C:\\Windows",
          WINDIR: "C:\\Windows",
          HUNT_GMAIL_HELPER_SOURCE: INTERACTIVE_GMAIL_OAUTH_SOURCE,
          HUNT_GMAIL_HELPER_SHA256: INTERACTIVE_GMAIL_OAUTH_SHA256,
        },
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      let terminalError: Error | undefined;
      const finish = (error?: Error, value?: Uint8Array) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        for (const chunk of chunks) chunk.fill(0);
        error === undefined ? resolve(value!) : reject(error);
      };
      const cancel = () => {
        if (terminalError !== undefined) return;
        terminalError = new Error("Gmail OAuth cancelled");
        child.kill();
      };
      const timer = setTimeout(() => {
        if (terminalError !== undefined) return;
        terminalError = new Error("Gmail OAuth timeout");
        child.kill();
      }, timeoutMs);
      signal.addEventListener("abort", cancel, { once: true });
      child.once("error", () => finish(new Error("Gmail OAuth sealing failed")));
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > maxOutputBytes) {
          chunk.fill(0);
          terminalError = new Error("Gmail OAuth sealing failed");
          child.kill();
          return;
        }
        chunks.push(Buffer.from(chunk));
        chunk.fill(0);
      });
      child.once("close", (code) => {
        if (terminalError !== undefined) {
          finish(terminalError);
          return;
        }
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

function trustedHelperSourcePath(): string {
  const candidate = fileURLToPath(
    new URL("./interactive-gmail-oauth-sealer.ts", import.meta.url),
  );
  const info = lstatSync(candidate);
  if (
    !info.isFile() || info.isSymbolicLink() || info.size < 10_000 || info.size > 128 * 1024 ||
    realpathSync.native(candidate) !== candidate
  ) {
    throw new Error("Gmail OAuth helper invalid");
  }
  return candidate;
}

function encodeSections(request: GmailOAuthSealRequest): Buffer {
  const binding = Buffer.from(JSON.stringify(request.binding), "utf8");
  const clientId = Buffer.from(request.clientId, "utf8");
  const installedClientConfigPath = Buffer.from(request.installedClientConfigPath, "utf8");
  const senderPolicyConfigPath = Buffer.from(request.senderPolicyConfigPath, "utf8");
  const values = [
    Buffer.from(request.gmailMetadata),
    Buffer.from(request.accountMetadata),
    Buffer.from(request.accountCiphertext),
    clientId,
    installedClientConfigPath,
    senderPolicyConfigPath,
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

function encodeRevokeSections(request: GmailRefreshGrantRevokeRequest): Buffer {
  const values = [
    Buffer.from(request.recipientBindingId, "utf8"),
    Buffer.from(request.clientId, "utf8"),
    Buffer.from(request.installedClientConfigPath, "utf8"),
  ];
  try {
    if (values.some((value) => value.byteLength < 1 || value.byteLength > DEFAULT_BOUND)) {
      throw new Error("Gmail OAuth sealing failed");
    }
    const output = Buffer.allocUnsafe(
      6 + values.reduce((sum, value) => sum + 4 + value.byteLength, 0),
    );
    REVOKE_INPUT_MAGIC.copy(output, 0);
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

function encodeReconcileSections(request: GmailOAuthSealRequest): Buffer {
  const values = [
    Buffer.from(request.accountMetadata),
    Buffer.from(request.accountCiphertext),
    Buffer.from(request.clientId, "utf8"),
    Buffer.from(request.installedClientConfigPath, "utf8"),
    Buffer.from(request.binding.recipientBindingId, "utf8"),
  ];
  try {
    if (values.some((value) => value.byteLength < 1 || value.byteLength > DEFAULT_BOUND)) {
      throw new Error("Gmail OAuth reconciliation failed");
    }
    const output = Buffer.allocUnsafe(
      6 + values.reduce((sum, value) => sum + 4 + value.byteLength, 0),
    );
    RECONCILE_INPUT_MAGIC.copy(output, 0);
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

function parseRevokeResult(value: Uint8Array): "revoked" | "absent" {
  const input = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (
    input.byteLength !== 6 ||
    !input.subarray(0, 4).equals(REVOKE_OUTPUT_MAGIC) ||
    input.readUInt8(4) !== 1 ||
    (input.readUInt8(5) !== 0 && input.readUInt8(5) !== 1)
  ) throw new Error("Gmail OAuth sealing failed");
  return input.readUInt8(5) === 1 ? "revoked" : "absent";
}

function parseReconcileResult(value: Uint8Array): void {
  const input = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (
    input.byteLength !== 6 ||
    !input.subarray(0, 4).equals(RECONCILE_OUTPUT_MAGIC) ||
    input.readUInt8(4) !== 1 ||
    (input.readUInt8(5) !== 0 && input.readUInt8(5) !== 1)
  ) throw new Error("Gmail OAuth reconciliation failed");
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
                : code === 10
                  ? "Gmail sender policy invalid"
                  : code === 11
                    ? "Gmail refresh grant invalid"
                  : code === 12
                      ? "Gmail refresh unavailable"
                    : code === 13
                      ? "Gmail OAuth handoff unavailable"
              : "Gmail OAuth sealing failed";
  return new Error(message);
}

function recognized(error: unknown): error is Error {
  return error instanceof Error &&
    /^Gmail (?:OAuth|mailbox identity|refresh (?:grant|unavailable))/u.test(error.message);
}

function requiresReconciliation(error: unknown): boolean {
  return error instanceof Error && (
    error.message === "Gmail OAuth cancelled" ||
    error.message === "Gmail OAuth timeout" ||
    error.message === "Gmail OAuth sealing failed"
  );
}
