part of 'settings.dart';

class _ProjectAgentSettings extends StatelessWidget {
  final TaskController controller;
  final Project project;
  const _ProjectAgentSettings({
    required this.controller,
    required this.project,
  });

  @override
  Widget build(BuildContext context) => _RemotePage<List<Json>>(
    title: 'Agent setup',
    subtitle: project.name,
    load: () => Future.wait([
      controller.settingsRequest(
        'GET',
        '/projects/${project.id}/agent-settings',
      ),
      controller.settingsRequest('GET', '/agents'),
    ]),
    builder: (context, data, _) => (
      actions: const <Widget>[],
      body: _ProjectAgentEditor(
        key: ValueKey(project.id),
        controller: controller,
        project: project,
        settings: data[0]['settings'] as Json,
        agents: objects(data[1]['agents']),
      ),
    ),
  );
}

class _ProjectAgentEditor extends StatefulWidget {
  final TaskController controller;
  final Project project;
  final Json settings;
  final List<Json> agents;
  const _ProjectAgentEditor({
    super.key,
    required this.controller,
    required this.project,
    required this.settings,
    required this.agents,
  });

  @override
  State<_ProjectAgentEditor> createState() => _ProjectAgentEditorState();
}

class _ProjectAgentEditorState extends State<_ProjectAgentEditor> {
  late Json _settings = widget.settings;
  late final _script = TextEditingController(
    text: _settings['setupScript'] as String? ?? '',
  );
  late final _instructions = TextEditingController(
    text: _settings['agentInstructions'] as String? ?? '',
  );
  late String _savedScript = _script.text;
  late String _savedInstructions = _instructions.text;
  late String? _defaultAgentId = _settings['defaultAgentId'] as String?;
  late String? _savedDefaultAgentId = _defaultAgentId;
  Timer? _debounce;
  Future<bool>? _saveFuture;
  String? _saveError, _envError;
  bool _saving = false, _envBusy = false;
  bool get _admin => widget.controller.user?.isAdmin == true;
  String get _path => '/projects/${widget.project.id}';
  bool get _dirty => _changes.isNotEmpty;
  Json get _changes => {
    if (_script.text != _savedScript) 'setupScript': _script.text,
    if (_instructions.text != _savedInstructions)
      'agentInstructions': _instructions.text,
    if (_defaultAgentId != _savedDefaultAgentId)
      'defaultAgentId': _defaultAgentId,
  };

  @override
  void initState() {
    super.initState();
    _script.addListener(_edited);
    _instructions.addListener(_edited);
  }

  @override
  void didUpdateWidget(_ProjectAgentEditor oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (identical(oldWidget.settings, widget.settings)) return;
    _settings = widget.settings;
    // A refresh may update clean fields while local edits remain the User's.
    if (_saving) return;
    if (_script.text == _savedScript) {
      _savedScript = _settings['setupScript'] as String? ?? '';
      _script.removeListener(_edited);
      _script.text = _savedScript;
      _script.addListener(_edited);
    }
    if (_instructions.text == _savedInstructions) {
      _savedInstructions = _settings['agentInstructions'] as String? ?? '';
      _instructions.removeListener(_edited);
      _instructions.text = _savedInstructions;
      _instructions.addListener(_edited);
    }
    if (_defaultAgentId == _savedDefaultAgentId) {
      _defaultAgentId = _savedDefaultAgentId =
          _settings['defaultAgentId'] as String?;
    }
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _script.dispose();
    _instructions.dispose();
    super.dispose();
  }

  void _edited() {
    setState(() => _saveError = null);
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 600), _flush);
  }

  Future<bool> _flush() {
    _debounce?.cancel();
    return _saveFuture ??= _saveChanges().whenComplete(
      () => _saveFuture = null,
    );
  }

  Future<bool> _saveChanges() async {
    if (!_dirty) return true;
    setState(() {
      _saving = true;
      _saveError = null;
    });
    try {
      while (mounted && _dirty) {
        final changes = _changes;
        await widget.controller.settingsRequest(
          'PATCH',
          '$_path/agent-settings',
          body: changes,
        );
        if (!mounted) return true;
        setState(() {
          if (changes.containsKey('setupScript')) {
            _savedScript = changes['setupScript'] as String;
          }
          if (changes.containsKey('agentInstructions')) {
            _savedInstructions = changes['agentInstructions'] as String;
          }
          if (changes.containsKey('defaultAgentId')) {
            _savedDefaultAgentId = changes['defaultAgentId'] as String?;
          }
        });
      }
      return true;
    } catch (e) {
      if (mounted) setState(() => _saveError = e.toString());
      return false;
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _pickAgent() async {
    final selected = await showPicker<String>(
      context,
      title: 'Default Agent',
      selected: _defaultAgentId ?? '',
      options: [
        const PickerOption('', 'No Agent'),
        for (final agent in widget.agents)
          if (agent['enabled'] == true || agent['id'] == _defaultAgentId)
            PickerOption(
              agent['id'] as String,
              agent['name'] as String,
              detail: agent['enabled'] == true ? null : 'Disabled',
            ),
      ],
    );
    if (selected == null || !mounted) return;
    setState(() => _defaultAgentId = selected.isEmpty ? null : selected);
    await _flush();
  }

  Future<void> _envChange(String method, String suffix, [Json? body]) async {
    setState(() {
      _envBusy = true;
      _envError = null;
    });
    try {
      final result = await widget.controller.settingsRequest(
        method,
        '$_path/$suffix',
        body: body,
      );
      if (mounted) setState(() => _settings = result['settings'] as Json);
    } finally {
      if (mounted) setState(() => _envBusy = false);
    }
  }

  Future<void> _editVariable([Json? variable]) => showAppSheet<void>(
    context,
    builder: (_) => _ProjectEnvSheet(
      variable: variable,
      save: (name, value, secret) => _envChange(
        'PUT',
        'env/${Uri.encodeComponent(name)}',
        {'value': value, 'secret': secret},
      ),
    ),
  );

  Future<void> _removeVariable(Json variable) async {
    final name = variable['name'] as String;
    if (!await confirm(
          context,
          title: 'Delete $name?',
          message: 'The variable will be absent from the next Job.',
          confirmLabel: 'Delete variable',
        ) ||
        !mounted) {
      return;
    }
    try {
      await _envChange('DELETE', 'env/${Uri.encodeComponent(name)}');
    } catch (e) {
      if (mounted) setState(() => _envError = e.toString());
    }
  }

  Future<void> _importEnv() => showAppSheet<void>(
    context,
    builder: (_) => _ProjectEnvImport(
      existing: objects(_settings['env']),
      save: (content, secret) => _envChange('POST', 'env/import', {
        'content': content,
        'secret': secret,
      }),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final selected = widget.agents
        .where((a) => a['id'] == _defaultAgentId)
        .firstOrNull;
    return PopScope(
      canPop: !_dirty && !_saving,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop || !await _flush() || !mounted) return;
        // Let PopScope see the saved state before trying to leave again.
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) Navigator.of(context).pop();
        });
      },
      child: _list([
        Section(
          title: 'Agent setup',
          children: [
            LabeledField(
              label: 'Default Agent',
              description:
                  'Assigned to new Tasks while enabled. The first User Comment starts the Agent.',
              child: SelectField(
                leading: selected == null
                    ? null
                    : UserAvatar(
                        label: selected['name'] as String,
                        userId: selected['id'] as String,
                        imageUrl: selected['avatarImageUrl'] as String?,
                        emoji: selected['avatarEmoji'] as String? ?? '🤖',
                        api: widget.controller.api,
                        size: 26,
                        circle: false,
                      ),
                label: selected == null
                    ? 'No Agent'
                    : '${selected['name']}${selected['enabled'] == true ? '' : ' (disabled)'}',
                placeholder: selected == null,
                onTap: _pickAgent,
              ),
            ),
            _autoField(
              'Worktree Setup Script',
              _script,
              hint: 'Runs once for each new Worktree, before Claude starts.',
              code: true,
            ),
            _autoField(
              'Agent Instructions',
              _instructions,
              hint:
                  'Applied to every Agent working on this Project, alongside the Repository instructions.',
            ),
            if (_saveError != null)
              Notice.error(
                _saveError!,
                actionLabel: 'Retry',
                onAction: _saving ? null : _flush,
              )
            else
              Semantics(
                liveRegion: true,
                child: Row(
                  children: [
                    Icon(
                      _saving
                          ? Icons.sync_rounded
                          : _dirty
                          ? Icons.edit_note_rounded
                          : Icons.check_circle_outline_rounded,
                      size: 15,
                      color: _saving || _dirty
                          ? Palette.fgSubtle
                          : Palette.success,
                    ),
                    const SizedBox(width: 6),
                    Text(
                      _saving
                          ? 'Saving…'
                          : _dirty
                          ? 'Unsaved changes'
                          : 'Saved',
                      style: const TextStyle(
                        fontSize: 12,
                        color: Palette.fgSubtle,
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ),
        Section(
          title: 'Environment variables & secrets',
          description:
              'Sent only to Jobs for this Project. Admins manage variables and secrets.',
          trailing: _admin
              ? SectionAdd(
                  tooltip: 'Add variable',
                  onPressed: _envBusy ? null : _editVariable,
                )
              : null,
          children: [
            if (_envError != null)
              Padding(
                padding: const EdgeInsets.only(bottom: Space.row),
                child: Notice.error(_envError!),
              ),
            if (objects(_settings['env']).isEmpty)
              const EmptyHint('No variables yet.'),
            for (final variable in objects(_settings['env']))
              AppTile(
                leading: IconBadge(
                  variable['secret'] == true
                      ? Icons.lock_outline_rounded
                      : Icons.data_object_rounded,
                  color: variable['secret'] == true
                      ? Palette.warning
                      : Palette.info,
                ),
                title: variable['name'] as String,
                monospace: true,
                subtitle: variable['secret'] == true
                    ? 'Secret${variable['last4'] == null || variable['last4'] == '' ? '' : ' · …${variable['last4']}'}'
                    : variable['value'] as String? ?? '',
                onTap: _admin && !_envBusy
                    ? () => _editVariable(variable)
                    : null,
                trailing: _admin
                    ? IconAction(
                        icon: Icons.delete_outline_rounded,
                        tooltip: 'Delete ${variable['name']}',
                        size: 32,
                        onPressed: _envBusy
                            ? null
                            : () => _removeVariable(variable),
                      )
                    : null,
              ),
            if (_admin) ...[
              const SizedBox(height: 4),
              Align(
                alignment: Alignment.centerLeft,
                child: AppButton(
                  label: 'Import .env',
                  icon: Icons.upload_file_rounded,
                  tone: Tone.secondary,
                  compact: true,
                  onPressed: _envBusy ? null : _importEnv,
                ),
              ),
            ],
          ],
        ),
      ]),
    );
  }

  Widget _autoField(
    String label,
    TextEditingController controller, {
    required String hint,
    bool code = false,
  }) => LabeledField(
    label: label,
    description: hint,
    child: Focus(
      onFocusChange: (focused) {
        if (!focused && _dirty) unawaited(_flush());
      },
      child: TextField(
        key: ValueKey(label),
        controller: controller,
        decoration: const InputDecoration(counterText: ''),
        minLines: 4,
        maxLines: 8,
        maxLength: 100000,
        autocorrect: !code,
        enableSuggestions: !code,
        style: code ? const TextStyle(fontFamily: mono, fontSize: 12.5) : null,
      ),
    ),
  );
}

class _ProjectEnvSheet extends StatefulWidget {
  final Json? variable;
  final Future<void> Function(String name, String value, bool secret) save;
  const _ProjectEnvSheet({this.variable, required this.save});
  @override
  State<_ProjectEnvSheet> createState() => _ProjectEnvSheetState();
}

class _ProjectEnvSheetState extends State<_ProjectEnvSheet> {
  final _form = GlobalKey<FormState>();
  late final _name = TextEditingController(
    text: widget.variable?['name'] as String? ?? '',
  );
  late final _value = TextEditingController(
    text: widget.variable?['value'] as String? ?? '',
  );
  late bool _secret = widget.variable?['secret'] == true;
  bool _busy = false;
  String? _error;
  @override
  void dispose() {
    _name.dispose();
    _value.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.save(_name.text.trim(), _value.text, _secret);
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = e.toString();
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => SheetScaffold(
    title: widget.variable == null ? 'Add variable' : 'Edit variable',
    body: Form(
      key: _form,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Notice.error(_error!),
            ),
          LabeledField(
            label: 'Variable name',
            child: TextFormField(
              controller: _name,
              enabled: !_busy && widget.variable == null,
              maxLength: 128,
              autocorrect: false,
              enableSuggestions: false,
              decoration: const InputDecoration(counterText: ''),
              style: const TextStyle(fontFamily: mono),
              validator: (v) => validateProjectEnvName(v?.trim() ?? ''),
            ),
          ),
          LabeledField(
            label: widget.variable?['secret'] == true ? 'New value' : 'Value',
            description: widget.variable?['secret'] == true
                ? 'Stored secrets are write-only. Enter a replacement value to update this variable.'
                : null,
            child: TextFormField(
              controller: _value,
              enabled: !_busy,
              decoration: const InputDecoration(counterText: ''),
              maxLength: 100000,
              obscureText: _secret,
              autocorrect: false,
              enableSuggestions: false,
              validator: (v) =>
                  (_secret || widget.variable?['secret'] == true) &&
                      (v == null || v.isEmpty)
                  ? 'Enter a new value.'
                  : null,
            ),
          ),
          SwitchRow(
            label: 'Secret',
            description:
                'Write-only once saved; only the last 4 characters show.',
            value: _secret,
            onChanged: _busy ? null : (v) => setState(() => _secret = v),
          ),
        ],
      ),
    ),
    actions: [
      AppButton(
        label: 'Cancel',
        tone: Tone.secondary,
        onPressed: _busy ? null : () => Navigator.pop(context),
      ),
      AppButton(
        label: 'Save variable',
        busy: _busy,
        onPressed: _busy ? null : _save,
      ),
    ],
  );
}

class _ProjectEnvImport extends StatefulWidget {
  final List<Json> existing;
  final Future<void> Function(String content, bool secret) save;
  const _ProjectEnvImport({required this.existing, required this.save});
  @override
  State<_ProjectEnvImport> createState() => _ProjectEnvImportState();
}

class _ProjectEnvImportState extends State<_ProjectEnvImport> {
  final _content = TextEditingController();
  bool _secret = false, _busy = false;
  String? _error;
  @override
  void dispose() {
    _content.dispose();
    super.dispose();
  }

  Future<void> _chooseFile() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final file = await FilePicker.pickFile();
      if (file == null) return;
      // Bound reads before decoding; UTF-8 uses at most four bytes per character.
      if ((await file.length() ?? 0) > 2000000) {
        throw const FormatException('The .env file is too large.');
      }
      final content = utf8.decode(await file.readAsBytes());
      if (content.length > 500000) {
        throw const FormatException('The .env file is too large.');
      }
      if (mounted) _content.text = content;
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _import() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.save(_content.text, _secret);
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = e.toString();
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final preview = previewProjectEnv(_content.text);
    final existing = {for (final v in widget.existing) v['name']: v};
    return SheetScaffold(
      title: 'Import .env',
      subtitle: 'Matching names are overwritten. Existing secrets stay secret.',
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Notice.error(_error!),
            ),
          LabeledField(
            label: '.env content',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextField(
                  controller: _content,
                  enabled: !_busy,
                  style: const TextStyle(fontFamily: mono, fontSize: 12.5),
                  decoration: const InputDecoration(
                    hintText: 'API_URL=https://example.com',
                    counterText: '',
                  ),
                  minLines: 4,
                  maxLines: 8,
                  maxLength: 500000,
                  autocorrect: false,
                  enableSuggestions: false,
                  onChanged: (_) => setState(() {}),
                ),
                const SizedBox(height: 8),
                Align(
                  alignment: Alignment.centerLeft,
                  child: AppButton(
                    label: 'Choose file',
                    icon: Icons.folder_open_outlined,
                    tone: Tone.secondary,
                    compact: true,
                    onPressed: _busy ? null : _chooseFile,
                  ),
                ),
              ],
            ),
          ),
          if (_content.text.trim().isNotEmpty)
            if (preview.errors.isNotEmpty)
              Text(
                preview.errors.join('\n'),
                style: const TextStyle(color: Palette.danger),
              )
            else
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final name in preview.entries.keys)
                    Text(
                      '$name${existing.containsKey(name)
                          ? existing[name]!['secret'] == true
                                ? ' · overwrites secret'
                                : ' · overwrites'
                          : ''}',
                    ),
                ],
              ),
          const SizedBox(height: 12),
          SwitchRow(
            label: 'Import as secrets',
            value: _secret,
            onChanged: _busy ? null : (v) => setState(() => _secret = v),
          ),
        ],
      ),
      actions: [
        AppButton(
          label: 'Cancel',
          tone: Tone.secondary,
          onPressed: _busy ? null : () => Navigator.pop(context),
        ),
        AppButton(
          label: 'Import variables',
          busy: _busy,
          onPressed: _busy || !preview.valid ? null : _import,
        ),
      ],
    );
  }
}
