part of 'settings.dart';

class _ProjectAgentSettings extends StatelessWidget {
  final TaskController controller;
  final Project project;
  const _ProjectAgentSettings({
    required this.controller,
    required this.project,
  });

  @override
  Widget build(BuildContext context) => _Screen(
    title: 'Agent setup',
    subtitle: project.name,
    body: _Remote<List<Json>>(
      load: () => Future.wait([
        controller.settingsRequest(
          'GET',
          '/projects/${project.id}/agent-settings',
        ),
        controller.settingsRequest('GET', '/agents'),
      ]),
      builder: (context, data, _) => _ProjectAgentEditor(
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
        const SectionLabel('Agent setup'),
        _Item(
          title: 'Default Agent',
          subtitle: selected == null
              ? 'No Agent'
              : '${selected['name']}${selected['enabled'] == true ? '' : ' (disabled)'}',
          onTap: _pickAgent,
        ),
        const Text(
          'Assigned to new Tasks while enabled. The first User Comment starts the Agent.',
          style: TextStyle(fontSize: 12, color: Palette.fgSubtle),
        ),
        const SizedBox(height: 16),
        _autoField(
          'Worktree Setup Script',
          _script,
          hint: 'Runs once for each new Worktree, before Claude starts.',
          code: true,
        ),
        const SizedBox(height: 16),
        _autoField(
          'Agent Instructions',
          _instructions,
          hint: 'Applied to every Agent working on this Project, alongside the Repository instructions.',
        ),
        const SizedBox(height: 10),
        if (_saveError != null)
          Notice(
            message: _saveError!,
            color: Palette.danger,
            icon: Icons.error_outline_rounded,
            actionLabel: 'Retry',
            onAction: _saving ? null : _flush,
          )
        else
          Semantics(
            liveRegion: true,
            child: Text(
              _saving
                  ? 'Saving…'
                  : _dirty
                  ? 'Unsaved changes'
                  : 'Saved',
              style: const TextStyle(fontSize: 12, color: Palette.fgSubtle),
            ),
          ),
        const SizedBox(height: 24),
        const SectionLabel('Environment variables & secrets'),
        const Text(
          'Sent only to Jobs for this Project. Admins manage variables and secrets.',
          style: TextStyle(fontSize: 12, color: Palette.fgSubtle),
        ),
        const SizedBox(height: 12),
        if (_envError != null)
          Notice(
            message: _envError!,
            color: Palette.danger,
            icon: Icons.error_outline_rounded,
          ),
        if (objects(_settings['env']).isEmpty) const Text('No variables yet.'),
        for (final variable in objects(_settings['env']))
          _Item(
            title: variable['name'] as String,
            subtitle: variable['secret'] == true
                ? 'Secret${variable['last4'] == null || variable['last4'] == '' ? '' : ' · …${variable['last4']}'}'
                : variable['value'] as String? ?? '',
            onTap: _admin && !_envBusy ? () => _editVariable(variable) : null,
            trailing: _admin
                ? IconAction(
                    icon: Icons.delete_outline_rounded,
                    tooltip: 'Delete ${variable['name']}',
                    onPressed: _envBusy
                        ? null
                        : () => _removeVariable(variable),
                  )
                : null,
          ),
        if (_admin) ...[
          const SizedBox(height: 12),
          Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              AppButton(
                label: 'Add variable',
                icon: Icons.add_rounded,
                onPressed: _envBusy ? null : _editVariable,
              ),
              AppButton(
                label: 'Import .env',
                tone: Tone.secondary,
                onPressed: _envBusy ? null : _importEnv,
              ),
            ],
          ),
        ],
      ]),
    );
  }

  Widget _autoField(
    String label,
    TextEditingController controller, {
    required String hint,
    bool code = false,
  }) => Focus(
    onFocusChange: (focused) {
      if (!focused && _dirty) unawaited(_flush());
    },
    child: TextField(
      key: ValueKey(label),
      controller: controller,
      decoration: InputDecoration(
        labelText: label,
        helperText: hint,
        helperMaxLines: 3,
        alignLabelWithHint: true,
      ),
      minLines: 4,
      maxLines: 8,
      maxLength: 100000,
      autocorrect: !code,
      enableSuggestions: !code,
      style: code
          ? const TextStyle(fontFamily: 'GeistMono', fontSize: 12)
          : null,
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
            Notice(
              message: _error!,
              color: Palette.danger,
              icon: Icons.error_outline_rounded,
            ),
          TextFormField(
            controller: _name,
            enabled: !_busy && widget.variable == null,
            decoration: const InputDecoration(labelText: 'Variable name'),
            maxLength: 128,
            autocorrect: false,
            enableSuggestions: false,
            validator: (v) => validateProjectEnvName(v?.trim() ?? ''),
          ),
          const SizedBox(height: 12),
          if (widget.variable?['secret'] == true)
            const Padding(
              padding: EdgeInsets.only(bottom: 12),
              child: Text(
                'Stored secrets are write-only. Enter a replacement value to update this variable.',
              ),
            ),
          TextFormField(
            controller: _value,
            enabled: !_busy,
            decoration: InputDecoration(
              labelText: widget.variable?['secret'] == true
                  ? 'New value'
                  : 'Value',
            ),
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
          Row(
            children: [
              const Expanded(child: Text('Secret')),
              Switch(
                value: _secret,
                onChanged: _busy ? null : (v) => setState(() => _secret = v),
              ),
            ],
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
            Notice(
              message: _error!,
              color: Palette.danger,
              icon: Icons.error_outline_rounded,
            ),
          TextField(
            controller: _content,
            enabled: !_busy,
            decoration: const InputDecoration(
              labelText: '.env content',
              hintText: 'API_URL=https://example.com',
            ),
            minLines: 4,
            maxLines: 8,
            maxLength: 500000,
            autocorrect: false,
            enableSuggestions: false,
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 12),
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
          Row(
            children: [
              const Expanded(child: Text('Import as secrets')),
              Switch(
                value: _secret,
                onChanged: _busy ? null : (v) => setState(() => _secret = v),
              ),
            ],
          ),
          AppButton(
            label: 'Choose file',
            tone: Tone.secondary,
            onPressed: _busy ? null : _chooseFile,
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
