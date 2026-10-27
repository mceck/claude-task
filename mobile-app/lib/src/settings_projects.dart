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
          PickerOption(agent.id, agent.name),
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
  Widget build(BuildContext context) => SheetScaffold(
    title: 'New project',
    subtitle: 'The key is 2–6 uppercase letters and cannot change later',
    body: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (error != null) ...[
          Notice(
            message: error!,
            color: Palette.danger,
            icon: Icons.error_outline_rounded,
          ),
          const SizedBox(height: 12),
        ],
        const FieldLabel('Key'),
        TextField(
          controller: keyText,
          decoration: const InputDecoration(labelText: 'Key'),
          enabled: !saving,
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 14),
        const FieldLabel('Name'),
        TextField(
          controller: name,
          decoration: const InputDecoration(labelText: 'Name'),
          enabled: !saving,
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 14),
        const FieldLabel('Description'),
        TextField(controller: description, maxLines: 3, enabled: !saving),
        const SizedBox(height: 14),
        const FieldLabel('Default Agent'),
        AppButton(
          label:
              widget.controller.agents
                  .where((a) => a.id == agentId)
                  .firstOrNull
                  ?.name ??
              'No Agent',
          tone: Tone.secondary,
          onPressed: saving ? null : _pickAgent,
        ),
        const SizedBox(height: 14),
        const FieldLabel('Repository'),
        AppButton(
          label: repository == null
              ? 'No Repository'
              : '${repository!['owner']}/${repository!['name']}',
          tone: Tone.secondary,
          onPressed: saving || loading ? null : _pickRepository,
        ),
        if (loading)
          const Padding(
            padding: EdgeInsets.all(8),
            child: Center(child: Spinner()),
          ),
        if (repositoryError != null) ...[
          Notice(
            message: repositoryError!,
            color: Palette.danger,
            icon: Icons.error_outline_rounded,
          ),
          AppButton(
            label: 'Retry repositories',
            tone: Tone.ghost,
            onPressed: saving ? null : _loadRepositories,
          ),
        ],
        if (!loading && repositoryError == null && groups.isEmpty)
          const Text(
            'An Admin can add a Git Connection in Git settings to link a Repository.',
            style: TextStyle(color: Palette.fgSubtle),
          ),
        for (final group in groups)
          if (group['error'] != null)
            Notice(
              message:
                  '${(group['connection'] as Map)['name']}: ${group['error']}',
              color: Palette.danger,
              icon: Icons.error_outline_rounded,
            ),
        if (repository != null) ...[
          const SizedBox(height: 14),
          const FieldLabel('Base branch'),
          TextField(controller: baseBranch, enabled: !saving, maxLength: 250),
        ],
        const SizedBox(height: 24),
        AppButton(
          label: 'Create project',
          busy: saving,
          onPressed:
              saving || keyText.text.trim().isEmpty || name.text.trim().isEmpty
              ? null
              : _save,
        ),
      ],
    ),
  );
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
        AppButton(
          label: 'No Repository',
          tone: Tone.ghost,
          onPressed: () => Navigator.pop(context, <String, dynamic>{}),
        ),
        const FieldLabel('Search repositories'),
        TextField(
          decoration: const InputDecoration(
            hintText: 'Owner, group or Repository name',
          ),
          onChanged: (value) => setState(() => search = value.toLowerCase()),
        ),
        for (final group in widget.groups) ...[
          const SizedBox(height: 12),
          SectionLabel(
            '${(group['connection'] as Map)['name']} · ${(group['connection'] as Map)['host']}',
          ),
          if (group['error'] != null)
            Text(
              group['error'] as String,
              style: const TextStyle(color: Palette.danger),
            ),
          for (final repo in objects(group['repositories']))
            if ('${repo['owner']}/${repo['name']}'.toLowerCase().contains(
              search,
            ))
              _Item(
                title: '${repo['owner']}/${repo['name']}',
                subtitle:
                    '${repo['defaultBranch']}${repo['private'] == true ? ' · private' : ''}',
                onTap: () => Navigator.pop(context, repo),
              ),
        ],
      ],
    ),
  );
}
