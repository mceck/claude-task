part of 'settings.dart';

class _GitSettings extends StatelessWidget {
  final TaskController controller;
  const _GitSettings({required this.controller});

  @override
  Widget build(BuildContext context) {
    if (controller.user?.isAdmin != true) {
      return const _Screen(
        title: 'Git Connections',
        body: Center(child: Text('Admin access required.')),
      );
    }
    return _Remote<List<Json>>(
      load: () async => objects(
        (await controller.settingsRequest(
          'GET',
          '/git/connections',
        ))['connections'],
      ),
      builder: (context, connections, reload) {
        Future<void> edit([Json? entry]) => _form(
          context,
          title: entry == null ? 'Add connection' : 'Edit / rotate connection',
          subtitle: 'Secrets are encrypted and cannot be read back. Leave a new secret empty to keep the saved one.',
          fields: [
            if (entry == null)
              const _Choice('provider', 'Provider', [
                ('github', 'GitHub App'),
                ('gitlab', 'GitLab'),
              ], 'github'),
            _Text(
              'name',
              'Connection name',
              initial: entry?['name'] as String? ?? '',
              required: true,
            ),
            _Text(
              'appId',
              'GitHub App ID',
              initial: entry?['appId'] as String? ?? '',
              required: true,
              hint: 'Numeric App ID. Grant Contents and Pull requests read/write, Metadata read.',
            ),
            _Text(
              'privateKey',
              'Private key (PEM)',
              lines: 7,
              required: entry == null,
            ),
            if (entry == null)
              const _Text(
                'baseUrl',
                'GitLab URL',
                initial: 'https://gitlab.com',
                required: true,
              ),
            _Text(
              'token',
              'GitLab token',
              secret: true,
              required: entry == null,
              hint: 'api and write_repository scopes; saved tokens rotate automatically',
            ),
          ],
          visible: (f, v) {
            final github = (entry?['provider'] ?? v['provider']) == 'github';
            return switch (f.key) {
              'appId' || 'privateKey' => github,
              'baseUrl' || 'token' => !github,
              _ => true,
            };
          },
          submit: 'Save connection',
          onSubmit: (v) async {
            final provider = entry?['provider'] ?? v['provider'];
            final secret =
                (v[provider == 'github' ? 'privateKey' : 'token'] as String)
                    .trim();
            await controller.settingsRequest(
              entry == null ? 'POST' : 'PATCH',
              entry == null
                  ? '/git/connections'
                  : '/git/connections/${entry['id']}',
              body: {
                'name': (v['name'] as String).trim(),
                if (entry == null) 'provider': provider,
                if (provider == 'github')
                  'appId': (v['appId'] as String).trim(),
                if (provider == 'gitlab' && entry == null)
                  'baseUrl': (v['baseUrl'] as String).trim(),
                if (secret.isNotEmpty)
                  (provider == 'github' ? 'privateKey' : 'token'): secret,
              },
            );
            await reload();
          },
        );

        Future<void> remove(Json entry) async {
          if (!await confirm(
            context,
            title: 'Delete ${entry['name']}?',
            message: 'Its Repositories can no longer be linked.',
            confirmLabel: 'Delete connection',
          )) {
            return;
          }
          await controller.settingsRequest(
            'DELETE',
            '/git/connections/${entry['id']}',
          );
          await reload();
        }

        return _Screen(
          title: 'Git Connections',
          action: IconAction(
            icon: Icons.add_rounded,
            tooltip: 'Add connection',
            onPressed: () => edit(),
          ),
          body: _list([
            if (connections.isEmpty) const Text('No Git Connections yet.'),
            for (final entry in connections)
              _SettingsCard(
                key: ValueKey(entry['id']),
                title: entry['name'] as String,
                description: [
                  '${entry['provider'] == 'github' ? 'GitHub App' : 'GitLab'} · ${entry['host']}',
                  if (entry['appId'] != null) 'App ${entry['appId']}',
                  if (entry['secretLast4'] != null)
                    'Token …${entry['secretLast4']}',
                  if (entry['expiresAt'] != null)
                    'Expires ${entry['expiresAt']}',
                  if (entry['source'] == 'environment')
                    'Environment · read-only',
                  '${entry['linkedProjects']} linked Projects',
                  if ((entry['linkedProjects'] as num? ?? 0) > 0)
                    'Link Projects elsewhere before deleting this connection.',
                  if (entry['health'] case final Map health)
                    health['state'] == 'ok'
                        ? 'Connection healthy'
                        : '${health['state']}: ${health['message']}',
                  if (objects(entry['access']).isEmpty)
                    '${entry['provider'] == 'github' ? 'Installations' : 'Works as'}: none',
                ].join('\n'),
                actions: [
                  for (final access in objects(entry['access']))
                    _SettingsAction(
                      access['label'] as String,
                      () => openLink(access['url'] as String?),
                    ),
                  if (entry['source'] != 'environment') ...[
                    _SettingsAction('Edit / rotate', () => edit(entry)),
                    if ((entry['linkedProjects'] as num? ?? 0) == 0)
                      _SettingsAction('Delete connection', () => remove(entry)),
                  ],
                ],
              ),
          ]),
        );
      },
    );
  }
}

class _RepositorySettings extends StatelessWidget {
  final TaskController controller;
  final Project project;
  const _RepositorySettings({required this.controller, required this.project});
  @override
  Widget build(BuildContext context) => _Screen(
    title: 'Repository',
    subtitle: project.name,
    body: _Remote<List<Json>>(
      load: () => Future.wait([
        controller.settingsRequest('GET', '/projects/${project.id}/repository'),
        controller.settingsRequest('GET', '/git/repositories'),
      ]),
      builder: (context, data, reload) => _RepositoryEditor(
        key: ValueKey(project.id),
        controller: controller,
        project: project,
        settings: data[0],
        groups: objects(data[1]['groups']),
        reload: reload,
      ),
    ),
  );
}

class _RepositoryEditor extends StatefulWidget {
  final TaskController controller;
  final Project project;
  final Json settings;
  final List<Json> groups;
  final Future<void> Function() reload;
  const _RepositoryEditor({
    super.key,
    required this.controller,
    required this.project,
    required this.settings,
    required this.groups,
    required this.reload,
  });
  @override
  State<_RepositoryEditor> createState() => _RepositoryEditorState();
}

class _RepositoryEditorState extends State<_RepositoryEditor> {
  late Json? selected = widget.settings['repository'] as Json?;
  late final base = TextEditingController(
    text: selected?['baseBranch'] as String? ?? '',
  );
  String search = '';
  String? error;
  bool busy = false;
  bool get locked => widget.settings['hasOpenSessions'] == true;

  @override
  void dispose() {
    base.dispose();
    super.dispose();
  }

  bool sameRepository(Json a, Json b) =>
      a['connectionId'] == b['connectionId'] &&
      a['providerRepoId'] == b['providerRepoId'];

  Future<void> save({bool check = false}) async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final result = await widget.controller.settingsRequest(
        check ? 'POST' : 'PUT',
        '/projects/${widget.project.id}/repository${check ? '/check-protection' : ''}',
        body: check
            ? null
            : {
                'connectionId': selected!['connectionId'],
                'providerRepoId': selected!['providerRepoId'],
                if (base.text.trim().isNotEmpty) 'baseBranch': base.text.trim(),
              },
      );
      if (!check && mounted) {
        setState(() {
          selected = result['repository'] as Json?;
          base.text = selected?['baseBranch'] as String? ?? '';
        });
      }
      await widget.reload();
      unawaited(widget.controller.refresh().catchError((Object _) {}));
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final current = widget.settings['repository'] as Json?;
    final protection = current?['protection'] as Json?;
    return _list([
      if (error != null)
        Notice(
          message: error!,
          color: Palette.danger,
          icon: Icons.error_outline_rounded,
        ),
      if (locked)
        const Notice(
          message: 'Close every non-closed Session, including paused and pending Sessions, before changing the Repository. The Base Branch can still change.',
          color: Palette.info,
          icon: Icons.info_outline_rounded,
        ),
      if (selected != null)
        _Item(
          title: '${selected!['owner']}/${selected!['name']}',
          subtitle: 'Selected Repository',
          leading: const Icon(Icons.check_rounded, color: Palette.primary),
        ),
      if (widget.groups.isEmpty)
        const Text(
          'An Admin must add a Git Connection before a Repository can be linked.',
        ),
      const FieldLabel('Search repositories'),
      TextField(
        enabled: !busy && !locked,
        decoration: const InputDecoration(
          hintText: 'Owner, group or Repository name',
        ),
        onChanged: (v) => setState(() => search = v.toLowerCase()),
      ),
      const SizedBox(height: 12),
      for (final group in widget.groups) ...[
        SectionLabel(
          '${(group['connection'] as Map)['name']} · ${(group['connection'] as Map)['host']}',
        ),
        if (group['error'] != null)
          Notice(
            message: group['error'] as String,
            color: Palette.danger,
            icon: Icons.error_outline_rounded,
          ),
        if (objects(group['repositories']).isEmpty && group['error'] == null)
          const Text('No accessible Repositories.'),
        for (final repository in objects(group['repositories']))
          if ('${repository['owner']}/${repository['name']}'
              .toLowerCase()
              .contains(search))
            _Item(
              title: '${repository['owner']}/${repository['name']}',
              subtitle:
                  '${repository['defaultBranch']}${repository['private'] == true ? ' · private' : ''}',
              trailing:
                  selected != null && sameRepository(selected!, repository)
                  ? const Icon(Icons.check_rounded, color: Palette.primary)
                  : null,
              onTap: busy || locked
                  ? null
                  : () => setState(() {
                      selected = repository;
                      base.text = repository['defaultBranch'] as String? ?? '';
                    }),
            ),
      ],
      const FieldLabel('Base Branch'),
      TextField(controller: base, enabled: !busy, maxLength: 250),
      const SizedBox(height: 12),
      AppButton(
        label: 'Save repository',
        busy: busy,
        onPressed: busy || selected == null ? null : () => save(),
      ),
      if (current != null) ...[
        const SizedBox(height: 16),
        _Item(
          title: 'Open Repository',
          subtitle: current['webUrl'] as String?,
          onTap: () => openLink(current['webUrl'] as String?),
        ),
      ],
      if (protection != null) ...[
        const SectionLabel('Base Branch Protection'),
        const Text(
          'Pushes to the Base Branch are always blocked by the platform. Provider protection is an optional second line of defense.',
        ),
        const SizedBox(height: 8),
        Text(
          '${switch (protection['protected']) {
            true => 'Protected',
            false => 'Not protected',
            _ => 'Unknown',
          }} · ${current!['baseBranch']}',
        ),
        Text(protection['details'] as String? ?? ''),
        Text('Checked ${protection['checkedAt']}'),
        _Item(
          title: 'Provider branch settings',
          onTap: () => openLink(protection['settingsUrl'] as String?),
        ),
        AppButton(
          label: 'Re-check protection',
          tone: Tone.secondary,
          onPressed: busy ? null : () => save(check: true),
        ),
      ],
    ]);
  }
}
