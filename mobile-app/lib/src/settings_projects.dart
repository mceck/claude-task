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
  Json? repository;
  List<Json> groups = [];
  bool loading = true, saving = false;

  @override
  void initState() {
    super.initState();
    _loadRepositories();
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
            agent.name,
            trailing: agentFreeDot(agent.free),
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
          if (agentId != null) 'defaultAgentId': agentId,
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
            description:
                '2–6 uppercase letters, used in Task keys. It cannot change later.',
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
          LabeledField(
            label: 'Default Agent',
            hint: 'optional',
            child: SelectField(
              leading: agentAvatar(widget.controller.api, agent, size: 26),
              label: agent?.name ?? 'No Agent',
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
              saving || keyText.text.trim().isEmpty || name.text.trim().isEmpty
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
