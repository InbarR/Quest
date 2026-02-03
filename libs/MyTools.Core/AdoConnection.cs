using Microsoft.TeamFoundation.SourceControl.WebApi;
using Microsoft.TeamFoundation.Work.WebApi;
using Microsoft.TeamFoundation.WorkItemTracking.WebApi;
using Microsoft.TeamFoundation.WorkItemTracking.WebApi.Models;
using Microsoft.VisualStudio.Services.Common;
using Microsoft.VisualStudio.Services.WebApi;
using Microsoft.VisualStudio.Services.WebApi.Patch;
using Microsoft.VisualStudio.Services.WebApi.Patch.Json;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using WorkItem = Microsoft.TeamFoundation.WorkItemTracking.WebApi.Models.WorkItem;
using Azure.Core;
using Azure.Identity;

namespace MyTools.Core
{
    public class AdoConnection : IDisposable
    {
        const string delim = @"\";

        public const string Tags = "System.Tags";
        public const string Title = "System.Title";
        public const string AreaPath = "System.AreaPath";
        public const string AssignedTo = "System.AssignedTo";
        public const string Parent = "System.Parent";
        public const string ReproSteps = "Microsoft.VSTS.TCM.ReproSteps";
        public const string Description = "System.Description";
        public const string IterationPath = "System.IterationPath";
        public const string WorkItemType = "System.WorkItemType";
        public const string Cost = "OSG.Cost";
        public const string Triage = "Microsoft.VSTS.Common.Triage";
        public const string Priority = "Microsoft.VSTS.Common.Priority";
        public const string OriginalEstimate = "Microsoft.VSTS.Scheduling.OriginalEstimate";
        public const string RemainingWork = "Microsoft.VSTS.Scheduling.RemainingWork";

        const int BatchSize = 200;
        private const string AzureDevOpsScope = "499b84ac-1321-427f-aa17-267ca6975798/.default";
        private Uri _uri;

        private GitHttpClient? _gitClient;
        private VssConnection? _connection;
        private Action<string, string?> _log;
        private TokenCredential? _tokenCredential;
        private WorkItemTrackingHttpClient? _client;
        private AccessToken _token;

        public AdoConnection(Action<string, string?> logFunc, string adoUrl)
        {
            _log = logFunc;
            _uri = new Uri(adoUrl);
        }

        public async Task Connect()
        {
            _tokenCredential =
               new ChainedTokenCredential(
                   new AzureCliCredential(),
                   new VisualStudioCredential(),
                   new DefaultAzureCredential(
                       new DefaultAzureCredentialOptions
                       {
                           ExcludeEnvironmentCredential = true,
                           ExcludeAzurePowerShellCredential = true,
                           ExcludeWorkloadIdentityCredential = true,
                           ExcludeManagedIdentityCredential = true,
                           ExcludeVisualStudioCodeCredential = true,
                           ExcludeInteractiveBrowserCredential = false,
                           ExcludeAzureDeveloperCliCredential = true,
                       }));

            var scopes = new[] { AzureDevOpsScope };
            var tokenRequestContext = new TokenRequestContext(scopes, parentRequestId: null);

            _token = await _tokenCredential.GetTokenAsync(tokenRequestContext, CancellationToken.None);

            var credential = new VssBasicCredential(string.Empty, _token.Token);

            _connection = new VssConnection(_uri, credential);
            _client = _connection.GetClient<WorkItemTrackingHttpClient>();
        }

        public async Task<string> GetIteration(string project, string team)
        {
            if (_connection == null)
                throw new InvalidOperationException("Not connected. Call Connect() first.");

            var workClient = _connection.GetClient<WorkHttpClient>();
            var iterations = await workClient.GetTeamIterationsAsync(new Microsoft.TeamFoundation.Core.WebApi.Types.TeamContext(project, team), "current");

            if (iterations.Count == 0)
            {
                throw new Exception("Failed to get current iteration");
            }

            return iterations.First().Path;
        }

        private void AddField(Dictionary<string, string> fields, string field, string? value)
        {
            if (value == null)
            {
                return;
            }

            fields.Add($"/fields/{field}", value);
        }

        public static string GetProj(string area)
        {
            return area.Split(delim)[0];
        }

        public async Task<WorkItem?> CreateItem(AdoItem item, CancellationToken cancellationToken, string? link = null, List<(string, string)>? extraFields = null)
        {
            if (_client == null)
                throw new InvalidOperationException("Not connected. Call Connect() first.");

            var dict = new Dictionary<string, string>();
            var project = GetProj(item.AreaPath);

            var existId = await GetWorkItemIdByTitle(item.AreaPath, item.Title, project, (ItemType)Enum.Parse(typeof(ItemType), item.Type), cancellationToken: cancellationToken);
            if (existId.Length > 0)
            {
                _log($"Item already exists - {item.Title} ({existId[0].Id})", existId[0].Url);
                return null;
            }

            var tag = string.IsNullOrEmpty(item.Tag) ? "MyADO" : $"{item.Tag},MyADO";

            AddField(dict, AreaPath, item.AreaPath);
            AddField(dict, IterationPath, item.Iteration);
            AddField(dict, Tags, tag);
            AddField(dict, Title, item.Title);
            AddField(dict, Description, item.Description);
            AddField(dict, Priority, item.Priority?.ToString());
            AddField(dict, OriginalEstimate, item.Cost?.ToString());

            if (!string.IsNullOrEmpty(item.AssignedTo))
            {
                AddField(dict, AssignedTo, item.AssignedTo);
            }

            AddField(dict, ReproSteps, item.ReproSteps);

            if (extraFields != null)
            {
                foreach (var (field, value) in extraFields)
                {
                    AddField(dict, field, value);
                }
            }

            JsonPatchDocument json = new JsonPatchDocument();

            if (!item.AreaPath.Contains(delim))
            {
                throw new Exception($"Area path must contain {delim}");
            }

            foreach (var kv in dict)
            {
                json.Add(new JsonPatchOperation
                {
                    Operation = Operation.Add,
                    Path = kv.Key,
                    Value = kv.Value,
                });
            }

            if (!string.IsNullOrEmpty(link))
            {
                json.Add(new JsonPatchOperation
                {
                    Operation = Operation.Add,
                    Path = "/relations/-",
                    Value = new
                    {
                        rel = "Hyperlink",
                        url = link,
                        attributes = new
                        {
                            comment = "Copied from this item"
                        }
                    }
                });
            }

            if (!string.IsNullOrEmpty(item.Deliverable) || !string.IsNullOrEmpty(item.Scenario))
            {
                var parentId = await GetParentId(item, project, cancellationToken);

                json.Add(new JsonPatchOperation
                {
                    Operation = Operation.Add,
                    Path = "/relations/-",
                    Value = new
                    {
                        rel = "System.LinkTypes.Hierarchy-Reverse",
                        url = _uri + "/" + project + "/_apis/wit/workItems/" + parentId,
                        attributes = new
                        {
                            comment = "updated link parent"
                        }
                    }
                });
            }

            if (string.IsNullOrEmpty(item.Title))
            {
                return null;
            }

            var result = await _client.CreateWorkItemAsync(json, project, item.Type.ToString(), cancellationToken: cancellationToken);
            var url = (result.Links.Links["html"] as ReferenceLink)?.Href;

            _log($"Added item for {item.Title}. Task id {result.Id}", url);

            return result;
        }

        private async Task<WorkItemReference[]> GetWorkItemIdByTitle(string areaPath, string title, string project, ItemType type, CancellationToken cancellationToken)
        {
            var wiqlQuery = $"SELECT [System.Id] FROM workitems " +
            $"WHERE [System.WorkItemType] = \"{type}\" AND " +
            $"[System.Title] = \"{title}\" AND " +
            $"[System.AreaPath] UNDER '{areaPath}'";

            return await RunQuery(project, wiqlQuery, cancellationToken);
        }

        public async Task<WorkItemReference[]> RunQuery(string project, string query, CancellationToken cancellationToken)
        {
            if (_client == null)
                throw new InvalidOperationException("Not connected. Call Connect() first.");

            WorkItemQueryResult queryResult = await _client.QueryByWiqlAsync(new Wiql { Query = query }, project, cancellationToken: cancellationToken);
            return queryResult.WorkItems.ToArray();
        }

        public class WorkItemResult
        {
            public WorkItem[] Items { get; set; } = Array.Empty<WorkItem>();
            public string[] Fields { get; set; } = Array.Empty<string>();
        }

        public async Task<WorkItemResult> RunQueryEx(string project, string query, int? top, CancellationTokenSource cancellationToken)
        {
            if (_client == null)
                throw new InvalidOperationException("Not connected. Call Connect() first.");

            WorkItemQueryResult res = await _client.QueryByWiqlAsync(new Wiql { Query = query }, project, top: top, cancellationToken: cancellationToken.Token);
            var items = res.WorkItems.ToArray();

            if (items.Length == 0)
            {
                return new WorkItemResult
                {
                    Items = Array.Empty<WorkItem>(),
                    Fields = res.Columns.Select(c => c.Name).ToArray()
                };
            }

            string[]? fields = null;

            if (res.Columns.Count() < 20)
            {
                fields = res.Columns.Select(c => c.ReferenceName).ToArray();
            }

            List<WorkItem> allItems = new List<WorkItem>();

            for (int i = 0; i < items.Length; i += BatchSize)
            {
                var batch = items.Skip(i).Take(BatchSize).Select(r => r.Id).ToArray();
                var batchItems = await _client.GetWorkItemsAsync(batch, asOf: res.AsOf, expand: WorkItemExpand.All, cancellationToken: cancellationToken.Token);
                allItems.AddRange(batchItems);
            }

            return new WorkItemResult
            {
                Items = allItems.ToArray(),
                Fields = fields ?? Array.Empty<string>()
            };
        }

        public async Task<string?> GetWorkItemTitle(int workItemId, CancellationToken cancellationToken)
        {
            if (_client == null)
                throw new InvalidOperationException("Not connected. Call Connect() first.");

            try
            {
                var workItem = await _client.GetWorkItemAsync(workItemId, new[] { Title }, cancellationToken: cancellationToken);
                return workItem.Fields.ContainsKey(Title) ? workItem.Fields[Title]?.ToString() : null;
            }
            catch
            {
                return null;
            }
        }

        public async Task<WorkItem[]> GetWorkItemsBatch(int[] workItemIds, string[] fields, CancellationToken cancellationToken)
        {
            if (_client == null)
                throw new InvalidOperationException("Not connected. Call Connect() first.");

            try
            {
                var workItems = await _client.GetWorkItemsAsync(workItemIds, fields, cancellationToken: cancellationToken);
                return workItems.ToArray();
            }
            catch
            {
                return Array.Empty<WorkItem>();
            }
        }

        private static int? GetPullRequestIdFromUrl(string url)
        {
            // Example URL: vstfs:///Git/PullRequestId/{repoId}%2F{pullRequestId}
            var parts = url.Split("%2F");
            if (parts.Length > 1 && int.TryParse(parts.Last(), out int prId))
            {
                return prId;
            }

            return null;
        }

        public async Task<List<string>> GetPrInfo(WorkItem item)
        {
            if (_connection == null)
                throw new InvalidOperationException("Not connected. Call Connect() first.");

            var relations = item.Relations?.Where(r => r.Rel == "ArtifactLink" && r.Url.Contains("PullRequest")).ToList();
            if (relations == null || relations.Count == 0)
            {
                return new List<string>();
            }

            if (_gitClient == null)
            {
                _gitClient = _connection.GetClient<GitHttpClient>();
            }

            var prUrls = new List<string>();
            var prTasks = new List<Task>();

            Parallel.ForEach(relations, relation =>
            {
                var prId = GetPullRequestIdFromUrl(relation.Url);
                if (prId == null)
                {
                    return;
                }

                string prUrl = prId.ToString();

                prTasks.Add(Task.Run(async () =>
                {
                    try
                    {
                        var pr = await _gitClient!.GetPullRequestByIdAsync((int)prId);
                        var url = pr.Url.Replace("_apis/git/repositories", "_git").Replace("pullRequests", "pullRequest");
                        prUrl = $"{pr.Title} ({url})";
                    }
                    catch
                    {
                        // Silent fail
                    }

                    lock (prUrls)
                    {
                        prUrls.Add(prUrl);
                    }
                }));
            });

            await Task.WhenAll(prTasks);

            return prUrls;
        }

        public async Task DeleteItem(string project, int id, CancellationToken cancellationToken)
        {
            if (_client == null)
                throw new InvalidOperationException("Not connected. Call Connect() first.");

            await _client.DeleteWorkItemAsync(project, id, cancellationToken: cancellationToken);
        }

        private async Task<int> GetParentId(AdoItem item, string project, CancellationToken cancellationToken)
        {
            int? id;

            var parent = item.Type == ItemType.Deliverable.ToString() ? item.Scenario : item.Deliverable;
            var parentType = item.Type == ItemType.Deliverable.ToString() ? ItemType.Scenario : ItemType.Deliverable;

            _log($"Getting parent id for {item.Title} ({parent})", null);

            var ids = await GetWorkItemIdByTitle(item.AreaPath, parent!, project, parentType, cancellationToken);

            if (ids.Length > 1)
            {
                throw new Exception("Found multiple parents - " + string.Join(",", ids.Select(i => i.Id)));
            }

            if (ids.Length == 0)
            {
                try
                {
                    _log($"Didnt find parent {parent}, creating..", null);

                    var created = await CreateItem(new AdoItem
                    {
                        Title = parent!,
                        Type = parentType.ToString(),
                        AreaPath = item.AreaPath,
                        Iteration = item.Iteration,
                        AssignedTo = item.AssignedTo,
                        Tag = item.Tag,
                        Scenario = parentType == ItemType.Scenario ? null : item.Scenario,
                    }, cancellationToken);

                    id = created?.Id;
                }
                catch
                {
                    throw new Exception("Failed to create parent - " + parent);
                }
            }
            else
            {
                id = ids[0].Id;

                _log($"Found parent {item.Title} with id {id}", ids[0].Url);
            }

            return id ?? 0;
        }

        public void Dispose()
        {
            _connection?.Disconnect();
            _connection?.Dispose();
            _connection = null;

            _client?.Dispose();
        }
    }

    public class AdoItem
    {
        public string ADO { get; set; } = string.Empty;
        public string Type { get; set; } = string.Empty;
        public string Title { get; set; } = string.Empty;
        public string AreaPath { get; set; } = string.Empty;
        public string? AssignedTo { get; set; }
        public string? Iteration { get; set; }
        public string? Deliverable { get; set; }
        public string? Scenario { get; set; }
        public string? Description { get; set; }
        public string? Cost { get; set; }
        public string? Priority { get; set; }
        public string? Tag { get; set; }
        public string? ReproSteps { get; set; }
    }

    public enum ItemType
    {
        Task,
        Bug,
        Deliverable,
        Scenario
    }
}