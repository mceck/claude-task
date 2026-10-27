part of 'settings.dart';

bool _sameSelection(List<String> a, List<String> b) =>
    a.length == b.length && a.toSet().containsAll(b);

class _AgentExtensionStatus extends StatelessWidget {
  final TaskController controller;
  final Json agent;
  const _AgentExtensionStatus({required this.controller, required this.agent});
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      final live = controller.agents.byId(agent['id'] as String);
      final pending =
          live?.extensionsPending ?? agent['extensionsPending'] == true;
      final error = live == null
          ? agent['extensionsError'] as String?
          : live.extensionsError;
      return Column(
        children: [
          if (pending)
            Notice(
              key: const ValueKey('pending'),
              message:
                  '${agent['name']}: Extension changes apply before the next Job.',
              color: Palette.info,
              icon: Icons.schedule_rounded,
            ),
          if (pending) const SizedBox(height: Space.row),
          if (error != null) ...[
            Notice(
              message: '${agent['name']}: $error',
              color: Palette.danger,
              icon: Icons.error_outline_rounded,
            ),
            const SizedBox(height: Space.row),
          ],
        ],
      );
    },
  );
}

class _ExtensionsSettings extends StatelessWidget {
  final TaskController controller;
  const _ExtensionsSettings({required this.controller});

  @override
  Widget build(BuildContext context) {
    if (controller.user?.isAdmin != true) {
      return const _AdminOnly('Extensions');
    }
    return _RemotePage<List<Json>>(
      title: 'Extensions',
      subtitle: 'Shared catalog, assigned in each Agent’s configuration',
      load: () => Future.wait([
        controller.settingsRequest('GET', '/skills'),
        controller.settingsRequest('GET', '/plugins'),
        controller.settingsRequest('GET', '/mcp-servers'),
      ]),
      builder: (context, data, reload) {
        Future<void> change(String method, String path, [Json? body]) async {
          await controller.settingsRequest(method, path, body: body);
          await reload();
          unawaited(controller.refresh().catchError((Object _) {}));
        }

        Future<void> remove(String kind, Json entry) async {
          if (!await confirm(
            context,
            title: 'Delete ${entry['name']}?',
            message:
                'Unassign this Extension from every Agent before deleting it.',
            confirmLabel: 'Delete Extension',
          )) {
            return;
          }
          if (!context.mounted) return;
          await _run(context, () => change('DELETE', '/$kind/${entry['id']}'));
        }

        Future<void> plugin([Json? entry]) => _form(
          context,
          title: entry == null ? 'Add Plugin' : 'Edit Plugin',
          fields: [
            _Text(
              'name',
              'Plugin name',
              initial: entry?['name'] as String? ?? '',
              required: true,
              hint: 'plugin with a source, or plugin@marketplace without one',
            ),
            _Text(
              'source',
              'Marketplace source',
              initial: entry?['source'] as String? ?? '',
              hint: 'owner/repo, HTTPS or Git SSH URL',
            ),
            _Text(
              'description',
              'Description',
              initial: entry?['description'] as String? ?? '',
              lines: 2,
            ),
          ],
          submit: 'Save Plugin',
          onSubmit: (v) => change(
            entry == null ? 'POST' : 'PUT',
            entry == null ? '/plugins' : '/plugins/${entry['id']}',
            {
              'name': (v['name'] as String).trim(),
              'source': (v['source'] as String).trim(),
              'description': v['description'],
            },
          ),
        );

        Future<void> mcp(String type, [Json? entry]) => _form(
          context,
          title: entry == null ? 'Add MCP Server' : 'Edit MCP Server',
          subtitle:
              'Saved secrets stay unchanged when their fields are left empty.',
          fields: [
            _Text(
              'name',
              'Server name',
              initial: entry?['name'] as String? ?? '',
              required: true,
            ),
            _Text(
              'description',
              'Description',
              initial: entry?['description'] as String? ?? '',
              lines: 2,
            ),
            _Choice('type', 'Transport', const [
              ('http', 'HTTP'),
              ('sse', 'SSE'),
              ('stdio', 'stdio'),
            ], type),
            _Text(
              'url',
              'URL',
              initial: entry?['url'] as String? ?? '',
              required: true,
            ),
            _Text(
              'command',
              'Command',
              initial: entry?['command'] as String? ?? '',
              required: true,
              hint: 'Installed in the Agent Container',
            ),
            _Text(
              'args',
              'Arguments',
              initial: (entry?['args'] as List? ?? []).join('\n'),
              lines: 4,
              hint: 'One argument per line, without shell quoting',
            ),
            _KeyValues('headers', 'Headers', entry?['headers'] as Json? ?? {}),
            _KeyValues(
              'env',
              'Environment variables',
              entry?['env'] as Json? ?? {},
            ),
          ],
          visible: (f, v) => switch (f.key) {
            'url' || 'headers' => v['type'] != 'stdio',
            'command' || 'args' || 'env' => v['type'] == 'stdio',
            _ => true,
          },
          submit: 'Save MCP Server',
          onSubmit: (v) async {
            final stdio = v['type'] == 'stdio';
            final rows = v[stdio ? 'env' : 'headers'] as List<Json>;
            final keys = rows.map((r) => (r['key'] as String).trim()).toList();
            if (keys.toSet().length != keys.length) {
              throw StateError('Duplicate variable or header name');
            }
            for (var i = 0; i < rows.length; i++) {
              if (rows[i]['value'] == null && keys[i] != rows[i]['savedKey']) {
                throw StateError(
                  'Enter a replacement secret for renamed header or variable "${keys[i]}".',
                );
              }
            }
            final values = <String, dynamic>{
              for (var i = 0; i < rows.length; i++)
                keys[i]: {
                  'value': rows[i]['value'],
                  'secret': rows[i]['secret'],
                },
            };
            await change(
              entry == null ? 'POST' : 'PUT',
              entry == null ? '/mcp-servers' : '/mcp-servers/${entry['id']}',
              {
                'name': (v['name'] as String).trim(),
                'description': v['description'],
                'type': v['type'],
                'url': stdio ? '' : (v['url'] as String).trim(),
                'command': stdio ? (v['command'] as String).trim() : '',
                'args': stdio
                    ? (v['args'] as String)
                          .split('\n')
                          .where((a) => a.isNotEmpty)
                          .toList()
                    : <String>[],
                'headers': stdio ? <String, dynamic>{} : values,
                'env': stdio ? values : <String, dynamic>{},
              },
            );
          },
        );

        return (
          actions: const <Widget>[],
          body: _list([
            Section(
              title: 'Skills',
              trailing: IconAction(
                icon: Icons.download_rounded,
                tooltip: 'Import Skills',
                size: 32,
                onPressed: () => _form(
                  context,
                  title: 'Import Skills',
                  fields: const [
                    _Text(
                      'source',
                      'Skill source',
                      required: true,
                      hint: 'owner/repo, HTTPS or Git SSH URL',
                    ),
                    _Text(
                      'names',
                      'Skill names',
                      hint: 'Comma-separated; leave empty to import all',
                    ),
                  ],
                  submit: 'Import Skills',
                  onSubmit: (v) {
                    final names = (v['names'] as String).trim();
                    return change('POST', '/skills/import', {
                      'source': (v['source'] as String).trim(),
                      'skills': names.isEmpty
                          ? ['*']
                          : names
                                .split(RegExp(r'[,\s]+'))
                                .where((n) => n.isNotEmpty)
                                .toList(),
                    });
                  },
                ),
              ),
              children: [
                if (objects(data[0]['skills']).isEmpty)
                  const EmptyHint('No Skills yet.'),
                for (final entry in objects(data[0]['skills']))
                  _SettingsCard(
                    key: ValueKey(entry['id']),
                    title: '/${entry['name']}',
                    description:
                        '${entry['description']}\n${entry['source']} · ${entry['fileCount']} files${entry['userInvocable'] == false ? ' · Hidden from slash commands' : ''}',
                    actions: [
                      _SettingsAction(
                        'Reimport',
                        () => change('POST', '/skills/import', {
                          'source': entry['source'],
                          'skills': [entry['name']],
                        }),
                      ),
                      _SettingsAction('Delete', () => remove('skills', entry)),
                    ],
                  ),
              ],
            ),
            Section(
              title: 'Plugins',
              trailing: SectionAdd(
                tooltip: 'Add Plugin',
                onPressed: () => plugin(),
              ),
              children: [
                if (objects(data[1]['plugins']).isEmpty)
                  const EmptyHint('No Plugins yet.'),
                for (final entry in objects(data[1]['plugins']))
                  _SettingsCard(
                    key: ValueKey(entry['id']),
                    title: entry['name'] as String,
                    description:
                        '${entry['description'] ?? ''}\n${entry['source'] ?? ''}',
                    actions: [
                      _SettingsAction('Edit', () => plugin(entry)),
                      _SettingsAction(
                        'Update',
                        () => change(
                          'POST',
                          '/plugins/${entry['id']}/update',
                          {},
                        ),
                      ),
                      _SettingsAction('Delete', () => remove('plugins', entry)),
                    ],
                  ),
              ],
            ),
            Section(
              title: 'MCP Servers',
              trailing: SectionAdd(
                tooltip: 'Add MCP Server',
                onPressed: () => mcp('http'),
              ),
              children: [
                if (objects(data[2]['mcpServers']).isEmpty)
                  const EmptyHint('No MCP Servers yet.'),
                for (final entry in objects(data[2]['mcpServers']))
                  _SettingsCard(
                    key: ValueKey(entry['id']),
                    title: entry['name'] as String,
                    description:
                        '${entry['description'] ?? ''}\n${entry['type']} · ${entry['type'] == 'stdio' ? entry['command'] : entry['url']}',
                    actions: [
                      _SettingsAction(
                        'Edit',
                        () => mcp(entry['type'] as String, entry),
                      ),
                      _SettingsAction(
                        'Delete',
                        () => remove('mcp-servers', entry),
                      ),
                    ],
                  ),
              ],
            ),
          ]),
        );
      },
    );
  }
}

class _SettingsAction {
  final String label;
  final Future<void> Function() run;
  const _SettingsAction(this.label, this.run);
}

/// Serializes each card's actions and keeps errors visible next to the entry.
class _SettingsCard extends StatefulWidget {
  final String title, description;
  final List<_SettingsAction> actions;
  const _SettingsCard({
    super.key,
    required this.title,
    required this.description,
    required this.actions,
  });
  @override
  State<_SettingsCard> createState() => _SettingsCardState();
}

class _SettingsCardState extends State<_SettingsCard> {
  bool busy = false;
  String? error;
  Future<void> run(_SettingsAction action) async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await action.run();
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: Space.row),
    child: Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: Palette.surface,
        border: Border.all(color: Palette.border),
        borderRadius: BorderRadius.circular(Radii.md),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            widget.title,
            style: const TextStyle(
              fontSize: 14.5,
              height: 1.35,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            widget.description.trim(),
            style: const TextStyle(
              fontSize: 12.5,
              height: 1.35,
              color: Palette.fgSubtle,
            ),
          ),
          if (error != null) ...[
            const SizedBox(height: 10),
            Notice.error(error!),
          ],
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final action in widget.actions)
                AppButton(
                  label: action.label,
                  compact: true,
                  tone: action.label.startsWith('Delete')
                      ? Tone.danger
                      : Tone.secondary,
                  onPressed: busy ? null : () => run(action),
                ),
            ],
          ),
        ],
      ),
    ),
  );
}

class _McpValuesEditor extends StatelessWidget {
  final String label;
  final List<Json> Function() read;
  List<Json> get rows => read();
  final bool enabled;
  final ValueChanged<List<Json>> onChanged;
  const _McpValuesEditor({
    super.key,
    required this.label,
    required this.read,
    required this.enabled,
    required this.onChanged,
  });

  void update(int i, Json changes) => onChanged([
    for (var j = 0; j < rows.length; j++)
      j == i ? {...rows[j], ...changes} : rows[j],
  ]);

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: Space.field),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        FieldLabel(label),
        for (var i = 0; i < rows.length; i++)
          Container(
            key: ObjectKey(rows[i]['identity']),
            margin: const EdgeInsets.only(bottom: Space.row),
            padding: const EdgeInsets.fromLTRB(12, 12, 4, 4),
            decoration: BoxDecoration(
              color: Palette.surface,
              borderRadius: BorderRadius.circular(Radii.md),
              border: Border.all(color: Palette.border),
            ),
            child: Column(
              children: [
                TextFormField(
                  initialValue: rows[i]['key'] as String,
                  enabled: enabled,
                  decoration: InputDecoration(
                    labelText: '$label name ${i + 1}',
                  ),
                  onChanged: (v) => update(i, {'key': v}),
                ),
                const SizedBox(height: 8),
                TextFormField(
                  initialValue: rows[i]['value'] as String? ?? '',
                  enabled: enabled,
                  obscureText: rows[i]['secret'] == true,
                  autocorrect: false,
                  enableSuggestions: false,
                  decoration: InputDecoration(
                    labelText: '$label value ${i + 1}',
                    hintText: rows[i]['value'] == null
                        ? 'Saved secret …${rows[i]['last4'] ?? ''} (unchanged)'
                        : 'Value',
                  ),
                  onChanged: (v) => update(i, {'value': v}),
                ),
                Row(
                  children: [
                    const Text('Secret', style: TextStyle(fontSize: 13.5)),
                    const SizedBox(width: 8),
                    Switch(
                      value: rows[i]['secret'] == true,
                      onChanged: enabled
                          ? (v) => update(i, {
                              'secret': v,
                              if (rows[i]['value'] == null) 'value': '',
                            })
                          : null,
                    ),
                    const Spacer(),
                    IconAction(
                      icon: Icons.close_rounded,
                      tooltip: 'Remove $label ${i + 1}',
                      onPressed: enabled
                          ? () => onChanged([
                              for (var j = 0; j < rows.length; j++)
                                if (j != i) rows[j],
                            ])
                          : null,
                    ),
                  ],
                ),
              ],
            ),
          ),
        AppButton(
          label: 'Add $label',
          icon: Icons.add_rounded,
          tone: Tone.secondary,
          compact: true,
          onPressed: enabled
              ? () => onChanged([
                  ...rows,
                  {
                    'key': '',
                    'value': '',
                    'secret': false,
                    'identity': Object(),
                  },
                ])
              : null,
        ),
      ],
    ),
  );
}
