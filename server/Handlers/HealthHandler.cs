using Quest.Server.Protocol;

namespace Quest.Server.Handlers;

public class HealthHandler
{
    private const string Version = "0.2.0-ai-fix";

    public HealthCheckResponse Check()
    {
        return new HealthCheckResponse(
            Status: "ok",
            Version: Version,
            Timestamp: DateTime.UtcNow.ToString("O")
        );
    }

    public void Shutdown()
    {
        // Graceful shutdown - just let the main loop exit
        Environment.Exit(0);
    }
}
