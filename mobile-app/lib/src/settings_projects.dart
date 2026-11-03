part of 'settings.dart';

Future<void> showProjectForm(
  BuildContext context,
  TaskController c, {
  bool selectCreated = true,
}) => showAppSheet<void>(
  context,
  maxWidth: 580,
  builder: (_) =>
      _ProjectCreationForm(controller: c, selectCreated: selectCreated),
);

class _ProjectCreationForm extends StatefulWidget {
  final TaskController controller;
  final bool selectCreated;
  const _ProjectCreationForm({
    required this.controller,
    required this.selectCreated,
  });

  @override
  State<_ProjectCreationForm> createState() => _ProjectCreationFormState();
}

class _ProjectCreationFormState extends State<_ProjectCreationForm> {
  final keyText = TextEditingController();
  final name = TextEditingController();
  final description = TextEditingController();
  final baseBranch = TextEditingController();
  String? agentId, error, repositoryError;
  late String? workerId = soleWorkerId(widget.controller.workers);
  Json? repository;
  Json? clickup;
  String? clickupLabel;
  List<Json> clickupTokens = [];
  List<Json> groups = [];
  bool loading = true, saving = false;

  @override
  void initState() {
    super.initState();
    // Workers arrive and change live: the Worker field and Create follow.
    widget.controller.addListener(_changed);
    _loadRepositories();
    _loadClickUpTokens();
  }

  Future<void> _loadClickUpTokens() async {
    try {
      final result = await widget.controller.settingsRequest(
        'GET',
        '/clickup/credentials',
      );
      if (mounted) {
        setState(() => clickupTokens = objects(result['credentials']));
      }
    } catch (_) {
      // The ClickUp section simply stays hidden.
    }
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  Future<void> _loadRepositories() async {
    setState(() {
      loading = true;
      repositoryError = null;
    });
    try {
      final result = await widget.controller.settingsRequest(
        'GET',
        '/git/repositories',
      );
      if (mounted) setState(() => groups = objects(result['groups']));
    } catch (e) {
      if (mounted) setState(() => repositoryError = e.toString());
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_changed);
    keyText.dispose();
    name.dispose();
    description.dispose();
    baseBranch.dispose();
    super.dispose();
  }

  Future<void> _pickAgent() async {
    final selected = await showPicker<String>(
      context,
      title: 'Default Agent',
      selected: agentId ?? '',
      options: [
        const PickerOption('', 'No Agent'),
        for (final agent in widget.controller.agents.where((a) => a.enabled))
          PickerOption(
            agent.id,
            agent.pickerLabel,
            trailing: agentStateDot(agent),
          ),
      ],
    );
    if (selected != null && mounted) {
      setState(() => agentId = selected.isEmpty ? null : selected);
    }
  }

  Future<void> _pickRepository() async {
    final selected = await showAppSheet<Json>(
      context,
      maxWidth: 580,
      builder: (_) => _ProjectRepositoryPicker(groups: groups),
    );
    if (selected != null && mounted) {
      setState(() {
        repository = selected.isEmpty ? null : selected;
        baseBranch.text = repository?['defaultBranch'] as String? ?? '';
      });
    }
  }

  Future<void> _save() async {
    setState(() {
      saving = true;
      error = null;
    });
    try {
      final result = await widget.controller.settingsRequest(
        'POST',
        '/projects',
        body: {
          'key': keyText.text.trim().toUpperCase(),
          'name': name.text.trim(),
          'description': description.text,
          'workerId': workerId,
          if (agentId != null) 'defaultAgentId': agentId,
          if (clickup != null) 'clickup': clickup,
          if (repository != null)
            'repository': {
              'connectionId': repository!['connectionId'],
              'providerRepoId': repository!['providerRepoId'],
              if (baseBranch.text.trim().isNotEmpty)
                'baseBranch': baseBranch.text.trim(),
            },
        },
      );
      await widget.controller.refresh();
      if (widget.selectCreated) {
        await widget.controller.selectProject(
          Project.fromJson(result['project'] as Json),
        );
      }
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted) {
        setState(() {
          error = e.toString();
          saving = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final agent = widget.controller.agents.byId(agentId);
    final workers = widget.controller.workers;
    // A Worker created meanwhile is preselected when it is the only one.
    workerId ??= soleWorkerId(workers);
    return SheetScaffold(
      title: 'New project',
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Notice.error(error!),
            ),
          LabeledField(
            label: 'Key',
            description: '2–6 uppercase letters, used in Task keys. It cannot change later.',
            child: TextField(
              controller: keyText,
              enabled: !saving,
              autocorrect: false,
              textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(hintText: 'PAY'),
              onChanged: (_) => setState(() {}),
            ),
          ),
          LabeledField(
            label: 'Name',
            child: TextField(
              controller: name,
              enabled: !saving,
              textCapitalization: TextCapitalization.sentences,
              decoration: const InputDecoration(hintText: 'Payments'),
              onChanged: (_) => setState(() {}),
            ),
          ),
          LabeledField(
            label: 'Description',
            hint: 'optional',
            child: TextField(
              controller: description,
              maxLines: 3,
              enabled: !saving,
            ),
          ),
          WorkerField(
            controller: widget.controller,
            workerId: workerId,
            description: 'Where the Project’s Agents run.',
            onChanged: saving ? null : (id) => setState(() => workerId = id),
          ),
          LabeledField(
            label: 'Default Agent',
            hint: 'optional',
            child: SelectField(
              leading: agentAvatar(widget.controller.api, agent, size: 26),
              label: agent?.pickerLabel ?? 'No Agent',
              placeholder: agent == null,
              onTap: saving ? null : _pickAgent,
            ),
          ),
          LabeledField(
            label: 'Repository',
            hint: 'optional',
            description: !loading && repositoryError == null && groups.isEmpty
                ? 'An Admin can add a Git Connection in Git settings to link a Repository.'
                : null,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SelectField(
                  leading: loading ? const Spinner() : null,
                  label: repository == null
                      ? 'No Repository'
                      : '${repository!['owner']}/${repository!['name']}',
                  placeholder: repository == null,
                  onTap: saving || loading ? null : _pickRepository,
                ),
                if (repositoryError != null) ...[
                  const SizedBox(height: 8),
                  Notice.error(
                    repositoryError!,
                    actionLabel: 'Retry repositories',
                    onAction: saving ? null : _loadRepositories,
                  ),
                ],
                for (final group in groups)
                  if (group['error'] != null) ...[
                    const SizedBox(height: 8),
                    Notice.error(
                      '${(group['connection'] as Map)['name']}: ${group['error']}',
                    ),
                  ],
              ],
            ),
          ),
          if (clickupTokens.isNotEmpty)
            LabeledField(
              label: 'ClickUp',
              hint: 'optional',
              description: 'Imports the tasks of a ClickUp List or View now and keeps them in sync; the Statuses follow ClickUp’s.',
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  SelectField(
                    label: clickupLabel ?? 'Not linked',
                    placeholder: clickup == null,
                    onTap: saving
                        ? null
                        : () async {
                            final picked = await _pickClickUp(
                              context,
                              widget.controller,
                              clickupTokens,
                            );
                            if (picked != null && mounted) {
                              setState(() {
                                clickup = picked.$1;
                                clickupLabel = picked.$2;
                              });
                            }
                          },
                  ),
                  if (clickup != null)
                    AppButton(
                      label: 'Remove ClickUp link',
                      tone: Tone.ghost,
                      onPressed: saving
                          ? null
                          : () => setState(() {
                              clickup = null;
                              clickupLabel = null;
                            }),
                    ),
                ],
              ),
            ),
          if (repository != null)
            LabeledField(
              label: 'Base branch',
              child: TextField(
                controller: baseBranch,
                enabled: !saving,
                maxLength: 250,
                decoration: const InputDecoration(counterText: ''),
              ),
            ),
        ],
      ),
      actions: [
        AppButton(
          label: 'Cancel',
          tone: Tone.secondary,
          onPressed: saving ? null : () => Navigator.pop(context),
        ),
        AppButton(
          label: 'Create project',
          busy: saving,
          onPressed:
              saving ||
                  keyText.text.trim().isEmpty ||
                  name.text.trim().isEmpty ||
                  workers.byId(workerId) == null
              ? null
              : _save,
        ),
      ],
    );
  }
}

class _ProjectRepositoryPicker extends StatefulWidget {
  final List<Json> groups;
  const _ProjectRepositoryPicker({required this.groups});
  @override
  State<_ProjectRepositoryPicker> createState() =>
      _ProjectRepositoryPickerState();
}

class _ProjectRepositoryPickerState extends State<_ProjectRepositoryPicker> {
  String search = '';
  @override
  Widget build(BuildContext context) => SheetScaffold(
    title: 'Repository',
    body: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        TextField(
          decoration: const InputDecoration(
            hintText: 'Search owner, group or Repository name',
            prefixIcon: Icon(Icons.search_rounded, size: 19),
          ),
          onChanged: (value) => setState(() => search = value.toLowerCase()),
        ),
        const SizedBox(height: 16),
        AppTile(
          leading: const IconBadge(
            Icons.block_rounded,
            color: Palette.fgSubtle,
          ),
          title: 'No Repository',
          onTap: () => Navigator.pop(context, <String, dynamic>{}),
        ),
        for (final group in widget.groups)
          _RepositoryGroup(
            group: group,
            search: search,
            onSelect: (repo) => Navigator.pop(context, repo),
          ),
      ],
    ),
  );
}

/// One Git Connection's Repositories, with its failure if listing failed.
class _RepositoryGroup extends StatelessWidget {
  final Json group;
  final String search;
  final Json? selected;
  final ValueChanged<Json>? onSelect;
  const _RepositoryGroup({
    required this.group,
    required this.search,
    this.selected,
    this.onSelect,
  });

  static bool same(Json a, Json b) =>
      a['connectionId'] == b['connectionId'] &&
      a['providerRepoId'] == b['providerRepoId'];

  @override
  Widget build(BuildContext context) {
    final connection = group['connection'] as Map;
    final repositories = [
      for (final repo in objects(group['repositories']))
        if ('${repo['owner']}/${repo['name']}'.toLowerCase().contains(search))
          repo,
    ];
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SectionLabel('${connection['name']} · ${connection['host']}'),
          if (group['error'] != null)
            Padding(
              padding: const EdgeInsets.only(bottom: Space.row),
              child: Notice.error(group['error'] as String),
            )
          else if (repositories.isEmpty)
            EmptyHint(
              search.isEmpty
                  ? 'No accessible Repositories.'
                  : 'No Repositories match the search.',
            ),
          for (final repo in repositories)
            AppTile(
              title: '${repo['owner']}/${repo['name']}',
              subtitle:
                  '${repo['defaultBranch']}${repo['private'] == true ? ' · private' : ''}',
              selected: selected != null && same(selected!, repo),
              trailing: selected != null && same(selected!, repo)
                  ? const Icon(Icons.check_rounded, color: Palette.primary)
                  : null,
              onTap: onSelect == null ? null : () => onSelect!(repo),
            ),
        ],
      ),
    );
  }
}

/// Walks through token, workspace, List or View and filters; the body for `POST /projects` and a label for the form.
Future<(Json, String)?> _pickClickUp(
  BuildContext context,
  TaskController c,
  List<Json> tokens,
) async {
  Future<List<Json>> options(String path) async =>
      objects((await c.settingsRequest('GET', path))['options']);
  Future<String?> choose(String title, List<Json> list) => showPicker<String>(
    context,
    title: title,
    selected: '',
    options: [
      for (final o in list)
        PickerOption(o['id'] as String, o['name'] as String),
    ],
  );
  String nameOf(List<Json> list, String id) =>
      list.firstWhere((o) => o['id'] == id)['name'] as String;
  try {
    var tokenId = tokens.first['id'] as String;
    if (tokens.length > 1) {
      final picked = await choose('ClickUp token', [
        for (final t in tokens) {'id': t['id'], 'name': t['name']},
      ]);
      if (picked == null || !context.mounted) return null;
      tokenId = picked;
    }
    final teams = await options('/clickup/teams?credentialId=$tokenId');
    if (!context.mounted) return null;
    final teamId = await choose('Workspace', teams);
    if (teamId == null || !context.mounted) return null;
    final type = await showPicker<String>(
      context,
      title: 'Link to',
      selected: 'list',
      options: const [
        PickerOption('list', 'A List'),
        PickerOption('view', 'A View'),
      ],
    );
    if (type == null || !context.mounted) return null;
    String sourceId, sourceName;
    var query = '';
    if (type == 'list') {
      final spaces = await options(
        '/clickup/spaces?credentialId=$tokenId&teamId=$teamId',
      );
      if (!context.mounted) return null;
      final spaceId = await choose('Space', spaces);
      if (spaceId == null || !context.mounted) return null;
      final lists = await options(
        '/clickup/lists?credentialId=$tokenId&spaceId=$spaceId',
      );
      if (!context.mounted) return null;
      final listId = await choose('List', lists);
      if (listId == null || !context.mounted) return null;
      sourceId = listId;
      sourceName = nameOf(lists, listId);
      var confirmed = false;
      await _form(
        context,
        title: 'ClickUp filters',
        fields: const [
          _Text(
            'query',
            'Filters',
            hint: 'assignees[]=123&tags[]=backend&include_closed=true',
          ),
        ],
        submit: 'Use List',
        onSubmit: (v) async {
          query = (v['query'] as String).trim();
          confirmed = true;
        },
      );
      if (!confirmed) return null;
    } else {
      final views = await options(
        '/clickup/views?credentialId=$tokenId&teamId=$teamId',
      );
      if (!context.mounted) return null;
      final viewId = await choose('View', views);
      if (viewId == null) return null;
      sourceId = viewId;
      sourceName = nameOf(views, viewId);
    }
    return (
      {
        'credentialId': tokenId,
        'teamId': teamId,
        'sourceType': type,
        'sourceId': sourceId,
        'query': query,
      },
      'ClickUp ${type == 'list' ? 'List' : 'View'}: $sourceName',
    );
  } catch (e) {
    if (context.mounted) toast(context, e.toString());
    return null;
  }
}

Widget _clickUpSection(
  BuildContext context,
  TaskController c,
  Project project,
  Json info,
  Future<void> Function(String method, String path, [Json? body]) change,
) {
  final link = Json.from(info['clickup'] as Map);
  final synced = DateTime.tryParse(link['lastSyncedAt'] as String? ?? '');
  final query = link['query'] as String? ?? '';
  return Section(
    title: 'ClickUp',
    description: 'Synced every 5 minutes. Names, descriptions, attachments and statuses come from ClickUp; the status of a task goes both ways.',
    children: [
      AppTile(
        title: 'Source',
        subtitle:
            '${link['sourceType'] == 'view' ? 'View' : 'List'} ${link['sourceId']}${query.isEmpty ? '' : ' · $query'}',
      ),
      AppTile(
        title: 'Last sync',
        subtitle: synced == null ? 'never' : synced.toLocal().toString(),
      ),
      if (link['lastError'] != null) Notice.error(link['lastError'] as String),
      AppButton(
        label: 'Sync now',
        icon: Icons.sync_rounded,
        tone: Tone.secondary,
        onPressed: () => _run(
          context,
          () => change('POST', '/projects/${project.id}/clickup/sync'),
        ),
      ),
      AppButton(
        label: 'Remove ClickUp link',
        tone: Tone.danger,
        onPressed: () async {
          if (!await confirm(
            context,
            title: 'Remove the ClickUp link?',
            message: 'The statuses stay and every task becomes a local task: nothing is synced any more.',
            confirmLabel: 'Remove link',
          )) {
            return;
          }
          if (!context.mounted) return;
          await _run(
            context,
            () => change('DELETE', '/projects/${project.id}/clickup'),
          );
        },
      ),
    ],
  );
}
