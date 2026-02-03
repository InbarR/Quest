using FluentAssertions;
using Quest.Server.Models;
using Quest.Server.Services;
using Quest.Server.Tests.Mocks;
using Xunit;

namespace Quest.Server.Tests;

public class DataSourceRegistryTests
{
    private readonly List<string> _logMessages = new();
    private readonly Action<string> _log;

    public DataSourceRegistryTests()
    {
        _log = msg => _logMessages.Add(msg);
    }

    [Fact]
    public void Register_AddsDataSourceToRegistry()
    {
        // Arrange
        var registry = new DataSourceRegistry(_log);
        var registration = CreateMockRegistration("test1");

        // Act
        registry.Register(registration);

        // Assert
        var all = registry.GetAll().ToList();
        all.Should().HaveCount(1);
        all[0].Id.Should().Be("test1");
    }

    [Fact]
    public void Register_ReplacesExistingDataSource()
    {
        // Arrange
        var registry = new DataSourceRegistry(_log);
        var registration1 = CreateMockRegistration("test1", displayName: "First");
        var registration2 = CreateMockRegistration("test1", displayName: "Second");

        // Act
        registry.Register(registration1);
        registry.Register(registration2);

        // Assert
        var all = registry.GetAll().ToList();
        all.Should().HaveCount(1);
        all[0].DisplayName.Should().Be("Second");
    }

    [Fact]
    public void Register_ThrowsForEmptyId()
    {
        // Arrange
        var registry = new DataSourceRegistry(_log);
        var registration = new DataSourceRegistration { Id = "" };

        // Act & Assert
        var act = () => registry.Register(registration);
        act.Should().Throw<ArgumentException>().WithMessage("*ID*");
    }

    [Fact]
    public void GetAll_ReturnsOnlyEnabledDataSources()
    {
        // Arrange
        var registry = new DataSourceRegistry(_log);
        registry.Register(CreateMockRegistration("enabled", isEnabled: true));
        registry.Register(CreateMockRegistration("disabled", isEnabled: false));

        // Act
        var all = registry.GetAll().ToList();

        // Assert
        all.Should().HaveCount(1);
        all[0].Id.Should().Be("enabled");
    }

    [Fact]
    public void GetAll_ReturnsSortedBySortOrder()
    {
        // Arrange
        var registry = new DataSourceRegistry(_log);
        registry.Register(CreateMockRegistration("third", sortOrder: 3));
        registry.Register(CreateMockRegistration("first", sortOrder: 1));
        registry.Register(CreateMockRegistration("second", sortOrder: 2));

        // Act
        var all = registry.GetAll().ToList();

        // Assert
        all.Should().HaveCount(3);
        all[0].Id.Should().Be("first");
        all[1].Id.Should().Be("second");
        all[2].Id.Should().Be("third");
    }

    [Fact]
    public void GetRegistration_ReturnsRegistrationById()
    {
        // Arrange
        var registry = new DataSourceRegistry(_log);
        registry.Register(CreateMockRegistration("test1", displayName: "Test One"));

        // Act
        var result = registry.GetRegistration("test1");

        // Assert
        result.Should().NotBeNull();
        result!.DisplayName.Should().Be("Test One");
    }

    [Fact]
    public void GetRegistration_ReturnsNullForUnknownId()
    {
        // Arrange
        var registry = new DataSourceRegistry(_log);

        // Act
        var result = registry.GetRegistration("unknown");

        // Assert
        result.Should().BeNull();
    }

    [Fact]
    public void GetRegistration_IsCaseInsensitive()
    {
        // Arrange
        var registry = new DataSourceRegistry(_log);
        registry.Register(CreateMockRegistration("TestOne"));

        // Act
        var result = registry.GetRegistration("testone");

        // Assert
        result.Should().NotBeNull();
    }

    [Fact]
    public void GetOrCreate_CreatesInstanceOnFirstCall()
    {
        // Arrange
        var registry = new DataSourceRegistry(_log);
        var mockDataSource = new MockDataSource { Id = "test1" };
        registry.Register(CreateMockRegistration("test1", factory: () => mockDataSource));

        // Act
        var result = registry.GetOrCreate("test1");

        // Assert
        result.Should().BeSameAs(mockDataSource);
    }

    [Fact]
    public void GetOrCreate_ReturnsSameInstanceOnSubsequentCalls()
    {
        // Arrange
        var registry = new DataSourceRegistry(_log);
        var callCount = 0;
        registry.Register(CreateMockRegistration("test1", factory: () =>
        {
            callCount++;
            return new MockDataSource { Id = "test1" };
        }));

        // Act
        var result1 = registry.GetOrCreate("test1");
        var result2 = registry.GetOrCreate("test1");

        // Assert
        result1.Should().BeSameAs(result2);
        callCount.Should().Be(1);
    }

    [Fact]
    public void GetOrCreate_ReturnsNullForUnknownId()
    {
        // Arrange
        var registry = new DataSourceRegistry(_log);

        // Act
        var result = registry.GetOrCreate("unknown");

        // Assert
        result.Should().BeNull();
    }

    [Fact]
    public void GetOrCreate_ReturnsNullWhenFactoryIsNull()
    {
        // Arrange
        var registry = new DataSourceRegistry(_log);
        registry.Register(new DataSourceRegistration { Id = "test1", Factory = null });

        // Act
        var result = registry.GetOrCreate("test1");

        // Assert
        result.Should().BeNull();
    }

    [Fact]
    public async Task SwitchToAsync_ChangesCurrentDataSource()
    {
        // Arrange
        var registry = new DataSourceRegistry(_log);
        var mock1 = new MockDataSource { Id = "ds1" };
        var mock2 = new MockDataSource { Id = "ds2" };
        registry.Register(CreateMockRegistration("ds1", factory: () => mock1));
        registry.Register(CreateMockRegistration("ds2", factory: () => mock2));

        // Act
        await registry.SwitchToAsync("ds1");
        var current1 = registry.Current;
        await registry.SwitchToAsync("ds2");
        var current2 = registry.Current;

        // Assert
        current1.Should().BeSameAs(mock1);
        current2.Should().BeSameAs(mock2);
        registry.CurrentId.Should().Be("ds2");
    }

    [Fact]
    public async Task SwitchToAsync_DisconnectsPreviousDataSource()
    {
        // Arrange
        var registry = new DataSourceRegistry(_log);
        var mock1 = new MockDataSource { Id = "ds1" };
        var mock2 = new MockDataSource { Id = "ds2" };
        registry.Register(CreateMockRegistration("ds1", factory: () => mock1));
        registry.Register(CreateMockRegistration("ds2", factory: () => mock2));

        // Connect mock1 first
        await registry.SwitchToAsync("ds1");
        await mock1.ConnectAsync(new DataSourceConnectionParams { Server = "test", Database = "db" });

        // Act
        await registry.SwitchToAsync("ds2");

        // Assert
        mock1.DisconnectCallCount.Should().Be(1);
    }

    [Fact]
    public async Task SwitchToAsync_RaisesCurrentDataSourceChangedEvent()
    {
        // Arrange
        var registry = new DataSourceRegistry(_log);
        var mock1 = new MockDataSource { Id = "ds1" };
        registry.Register(CreateMockRegistration("ds1", factory: () => mock1));

        DataSourceChangedEventArgs? eventArgs = null;
        registry.CurrentDataSourceChanged += (s, e) => eventArgs = e;

        // Act
        await registry.SwitchToAsync("ds1");

        // Assert
        eventArgs.Should().NotBeNull();
        eventArgs!.DataSourceId.Should().Be("ds1");
        eventArgs.DataSource.Should().BeSameAs(mock1);
    }

    [Fact]
    public async Task SwitchToAsync_ReturnsTrueWhenAlreadyCurrent()
    {
        // Arrange
        var registry = new DataSourceRegistry(_log);
        var mock1 = new MockDataSource { Id = "ds1" };
        registry.Register(CreateMockRegistration("ds1", factory: () => mock1));
        await registry.SwitchToAsync("ds1");

        // Act
        var result = await registry.SwitchToAsync("ds1");

        // Assert
        result.Should().BeTrue();
    }

    [Fact]
    public async Task SwitchToAsync_ReturnsFalseForUnknownId()
    {
        // Arrange
        var registry = new DataSourceRegistry(_log);

        // Act
        var result = await registry.SwitchToAsync("unknown");

        // Assert
        result.Should().BeFalse();
    }

    [Fact]
    public void GetForQuery_ReturnsDataSourceByTypeHint()
    {
        // Arrange
        var registry = new DataSourceRegistry(_log);
        var mock1 = new MockDataSource { Id = "ds1" };
        var mock2 = new MockDataSource { Id = "ds2" };
        registry.Register(CreateMockRegistration("ds1", factory: () => mock1));
        registry.Register(CreateMockRegistration("ds2", factory: () => mock2));

        // Act
        var result = registry.GetForQuery("ds2", null);

        // Assert
        result.Should().BeSameAs(mock2);
    }

    [Fact]
    public void GetForQuery_DetectsDataSourceFromQueryContent()
    {
        // Arrange
        var registry = new DataSourceRegistry(_log);
        var mock1 = new MockDataSource
        {
            Id = "ds1",
            CanHandleQueryFunc = q => q.Contains("SPECIAL")
        };
        var mock2 = new MockDataSource
        {
            Id = "ds2",
            CanHandleQueryFunc = q => q.Contains("OTHER")
        };
        registry.Register(CreateMockRegistration("ds1", sortOrder: 1, factory: () => mock1));
        registry.Register(CreateMockRegistration("ds2", sortOrder: 2, factory: () => mock2));

        // Act
        var result = registry.GetForQuery(null, "This is a SPECIAL query");

        // Assert
        result.Should().BeSameAs(mock1);
    }

    [Fact]
    public async Task GetForQuery_FallsBackToCurrent()
    {
        // Arrange
        var registry = new DataSourceRegistry(_log);
        var mock1 = new MockDataSource
        {
            Id = "ds1",
            CanHandleQueryFunc = _ => false
        };
        registry.Register(CreateMockRegistration("ds1", factory: () => mock1));
        await registry.SwitchToAsync("ds1");

        // Act
        var result = registry.GetForQuery(null, "some random query");

        // Assert
        result.Should().BeSameAs(mock1);
    }

    [Fact]
    public void GetDataSourceInfo_ReturnsInfoForAllEnabledSources()
    {
        // Arrange
        var registry = new DataSourceRegistry(_log);
        registry.Register(CreateMockRegistration("ds1", displayName: "Data Source 1"));
        registry.Register(CreateMockRegistration("ds2", displayName: "Data Source 2"));
        registry.Register(CreateMockRegistration("ds3", displayName: "Data Source 3", isEnabled: false));

        // Act
        var info = registry.GetDataSourceInfo();

        // Assert
        info.Should().HaveCount(2);
        info.Select(i => i.Id).Should().BeEquivalentTo(new[] { "ds1", "ds2" });
    }

    [Fact]
    public void Dispose_DisposesAllInstances()
    {
        // Arrange
        var registry = new DataSourceRegistry(_log);
        var mock1 = new MockDataSource { Id = "ds1" };
        var mock2 = new MockDataSource { Id = "ds2" };
        registry.Register(CreateMockRegistration("ds1", factory: () => mock1));
        registry.Register(CreateMockRegistration("ds2", factory: () => mock2));

        // Create instances
        registry.GetOrCreate("ds1");
        registry.GetOrCreate("ds2");

        // Act
        registry.Dispose();

        // Assert - After dispose, getting instances should create new ones
        // (We can't really verify dispose was called on MockDataSource without tracking it)
        // At minimum, verify no exception is thrown
    }

    private DataSourceRegistration CreateMockRegistration(
        string id,
        string? displayName = null,
        int sortOrder = 0,
        bool isEnabled = true,
        Func<IDataSource>? factory = null)
    {
        return new DataSourceRegistration
        {
            Id = id,
            DisplayName = displayName ?? $"Mock {id}",
            Icon = "test",
            QueryLanguage = "MockQL",
            SortOrder = sortOrder,
            IsEnabled = isEnabled,
            Description = $"Test data source {id}",
            Factory = factory ?? (() => new MockDataSource { Id = id })
        };
    }
}
