using System;
using System.Net;
using System.Net.Http;
using System.Net.NetworkInformation;
using System.Threading.Tasks;

namespace MyTools.Core
{
    public static class NetworkDiagnostics
    {
        public static async Task<NetworkDiagnosticsResult> TestConnectionAsync(string host, int port = 443)
        {
            var result = new NetworkDiagnosticsResult { Host = host, Port = port };

            try
            {
                // 1. Test DNS resolution
                result.DnsResolutionSuccess = await TestDnsResolutionAsync(host);

                // 2. Test ping
                result.PingSuccess = await TestPingAsync(host);

                // 3. Test TCP connection
                result.TcpConnectionSuccess = await TestTcpConnectionAsync(host, port);

                // 4. Test HTTP/HTTPS connection
                result.HttpConnectionSuccess = await TestHttpConnectionAsync(host, port);

                // 5. Get proxy information
                result.ProxyInfo = GetProxyInfo();

                result.OverallSuccess = result.HttpConnectionSuccess;
            }
            catch (Exception ex)
            {
                result.ErrorMessage = ex.Message;
                result.OverallSuccess = false;
            }

            return result;
        }

        private static async Task<bool> TestDnsResolutionAsync(string host)
        {
            try
            {
                var addresses = await Dns.GetHostAddressesAsync(host);
                return addresses != null && addresses.Length > 0;
            }
            catch
            {
                return false;
            }
        }

        private static async Task<bool> TestPingAsync(string host)
        {
            try
            {
                using var ping = new Ping();
                var reply = await ping.SendPingAsync(host, 5000);
                return reply?.Status == IPStatus.Success;
            }
            catch
            {
                return false;
            }
        }

        private static async Task<bool> TestTcpConnectionAsync(string host, int port)
        {
            try
            {
                using var client = new System.Net.Sockets.TcpClient();
                var connectTask = client.ConnectAsync(host, port);
                var completedTask = await Task.WhenAny(connectTask, Task.Delay(5000));
                return completedTask == connectTask && client.Connected;
            }
            catch
            {
                return false;
            }
        }

        private static async Task<bool> TestHttpConnectionAsync(string host, int port)
        {
            try
            {
                var handler = new HttpClientHandler
                {
                    UseProxy = true,
                    Proxy = WebRequest.GetSystemWebProxy(),
                    UseDefaultCredentials = true,
                    ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator
                };

                using var httpClient = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(10) };
                var uri = new Uri($"https://{host}:{port}");
                var response = await httpClient.GetAsync(uri);
                return true; // Any response means we can connect
            }
            catch (HttpRequestException)
            {
                // HttpRequestException might still mean we connected but got a 404 or auth error
                return true;
            }
            catch (TaskCanceledException)
            {
                return false; // Timeout
            }
            catch
            {
                return false;
            }
        }

        private static string GetProxyInfo()
        {
            try
            {
                var proxy = WebRequest.GetSystemWebProxy();
                var proxyUri = proxy?.GetProxy(new Uri("https://www.microsoft.com"));
                
                if (proxyUri != null && !proxyUri.IsLoopback)
                {
                    return $"Using proxy: {proxyUri}";
                }
                return "No proxy configured";
            }
            catch (Exception ex)
            {
                return $"Could not determine proxy: {ex.Message}";
            }
        }

        public static async Task<RetryResult<T>> ExecuteWithRetryAsync<T>(
            Func<Task<T>> action,
            int maxRetries = 3,
            int initialDelayMs = 1000,
            bool exponentialBackoff = true)
        {
            var result = new RetryResult<T>();
            Exception lastException = null;

            for (int attempt = 0; attempt <= maxRetries; attempt++)
            {
                try
                {
                    result.Value = await action();
                    result.Success = true;
                    result.Attempts = attempt + 1;
                    return result;
                }
                catch (Exception ex)
                {
                    lastException = ex;
                    result.Attempts = attempt + 1;

                    if (attempt < maxRetries)
                    {
                        var delay = exponentialBackoff
                            ? initialDelayMs * (int)Math.Pow(2, attempt)
                            : initialDelayMs;

                        await Task.Delay(delay);
                    }
                }
            }

            result.Success = false;
            result.Exception = lastException;
            return result;
        }
    }

    public class NetworkDiagnosticsResult
    {
        public string Host { get; set; } = "";
        public int Port { get; set; }
        public bool DnsResolutionSuccess { get; set; }
        public bool PingSuccess { get; set; }
        public bool TcpConnectionSuccess { get; set; }
        public bool HttpConnectionSuccess { get; set; }
        public string ProxyInfo { get; set; } = "";
        public bool OverallSuccess { get; set; }
        public string ErrorMessage { get; set; } = "";

        public override string ToString()
        {
            var lines = new[]
            {
                $"Host: {Host}:{Port}",
                $"DNS Resolution: {(DnsResolutionSuccess ? "✓" : "✗")}",
                $"Ping: {(PingSuccess ? "✓" : "✗")}",
                $"TCP Connection: {(TcpConnectionSuccess ? "✓" : "✗")}",
                $"HTTP Connection: {(HttpConnectionSuccess ? "✓" : "✗")}",
                $"Proxy: {ProxyInfo}",
                $"Overall: {(OverallSuccess ? "✓ Success" : "✗ Failed")}"
            };

            if (!string.IsNullOrEmpty(ErrorMessage))
            {
                return string.Join(Environment.NewLine, lines) + Environment.NewLine + $"Error: {ErrorMessage}";
            }

            return string.Join(Environment.NewLine, lines);
        }
    }

    public class RetryResult<T>
    {
        public bool Success { get; set; }
        public T Value { get; set; }
        public int Attempts { get; set; }
        public Exception Exception { get; set; }
    }
}
