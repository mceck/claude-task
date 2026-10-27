part of 'settings.dart';

class _GitSettings extends StatelessWidget {
  final TaskController controller;
  const _GitSettings({required this.controller});

  @override
  Widget build(BuildContext context) {
    if (controller.user?.isAdmin != true) {
      return const _AdminOnly('Git Connections');
    }
    return _RemotePage<List<Json>>(
      title: 'Git Connections',
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
          subtitle:
              'Secrets are encrypted and cannot be read back. Leave a new secret empty to keep the saved one.',
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
              hint:
                  'Numeric App ID. Grant Contents and Pull requests read/write, Metadata read.',
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
              hint:
                  'api and write_repository scopes; saved tokens rotate automatically',
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

        return (
          actions: [
            IconAction(
              icon: Icons.add_rounded,
              tooltip: 'Add connection',
              filled: true,
              size: 36,
              onPressed: () => edit(),
            ),
          ],
          body: _list([
            if (connections.isEmpty) const EmptyHint('No Git Connections yet.'),
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
  Widget build(BuildContext context) => _RemotePage<List<Json>>(
    title: 'Repository',
    subtitle: project.name,
    load: () => Future.wait([
      controller.settingsRequest('GET', '/projects/${project.id}/repository'),
      controller.settingsRequest('GET', '/git/repositories'),
    ]),
    builder: (context, data, reload) => (
      actions: const <Widget>[],
      body: _RepositoryEditor(
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
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Notice.error(error!),
        ),
      if (locked)
        const Padding(
          padding: EdgeInsets.only(bottom: 12),
          child: Notice(
            message:
                'Close every non-closed Session, including paused and pending Sessions, before changing the Repository. The Base Branch can still change.',
            color: Palette.info,
            icon: Icons.info_outline_rounded,
          ),
        ),
      Section(
        title: 'Repository',
        description: widget.groups.isEmpty
            ? 'An Admin must add a Git Connection before a Repository can be linked.'
            : null,
        children: [
          if (selected != null)
            AppTile(
              leading: const IconBadge(
                Icons.check_rounded,
                color: Palette.primary,
              ),
              title: '${selected!['owner']}/${selected!['name']}',
              subtitle: 'Selected Repository',
              selected: true,
            ),
          TextField(
            enabled: !busy && !locked,
            decoration: const InputDecoration(
              hintText: 'Search owner, group or Repository name',
              prefixIcon: Icon(Icons.search_rounded, size: 19),
            ),
            onChanged: (v) => setState(() => search = v.toLowerCase()),
          ),
          for (final group in widget.groups)
            _RepositoryGroup(
              group: group,
              search: search,
              selected: selected,
              onSelect: busy || locked
                  ? null
                  : (repository) => setState(() {
                      selected = repository;
                      base.text = repository['defaultBranch'] as String? ?? '';
                    }),
            ),
        ],
      ),
      Section(
        title: 'Base Branch',
        children: [
          TextField(
            controller: base,
            enabled: !busy,
            maxLength: 250,
            decoration: const InputDecoration(counterText: ''),
          ),
          const SizedBox(height: 12),
          AppButton(
            label: 'Save repository',
            busy: busy,
            onPressed: busy || selected == null ? null : () => save(),
          ),
          if (current != null) ...[
            const SizedBox(height: 12),
            AppTile(
              leading: const IconBadge(Icons.code_rounded, color: Palette.info),
              title: 'Open Repository',
              subtitle: current['webUrl'] as String?,
              trailing: externalMark,
              onTap: () => openLink(current['webUrl'] as String?),
            ),
          ],
        ],
      ),
      if (protection != null)
        Section(
          title: 'Base Branch Protection',
          description:
              'Pushes to the Base Branch are always blocked by the platform. Provider protection is an optional second line of defense.',
          children: [
            AppTile(
              leading: IconBadge(
                switch (protection['protected']) {
                  true => Icons.verified_user_outlined,
                  false => Icons.gpp_maybe_outlined,
                  _ => Icons.help_outline_rounded,
                },
                color: switch (protection['protected']) {
                  true => Palette.success,
                  false => Palette.warning,
                  _ => Palette.fgSubtle,
                },
              ),
              title:
                  '${switch (protection['protected']) {
                    true => 'Protected',
                    false => 'Not protected',
                    _ => 'Unknown',
                  }} · ${current!['baseBranch']}',
              subtitle: protection['details'] as String?,
              subtitleLines: 4,
            ),
            Padding(
              padding: const EdgeInsets.only(left: 2, bottom: 12),
              child: Text(
                'Checked ${protection['checkedAt']}',
                style: const TextStyle(fontSize: 12, color: Palette.fgSubtle),
              ),
            ),
            AppTile(
              title: 'Provider branch settings',
              trailing: externalMark,
              onTap: () => openLink(protection['settingsUrl'] as String?),
            ),
            AppButton(
              label: 'Re-check protection',
              icon: Icons.refresh_rounded,
              tone: Tone.secondary,
              onPressed: busy ? null : () => save(check: true),
            ),
          ],
        ),
    ]);
  }
}
