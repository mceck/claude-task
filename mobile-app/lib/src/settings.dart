import 'dart:async';

import 'package:material_ui/material_ui.dart';

import 'controller.dart';
import 'models.dart';
import 'task_forms.dart' show openLink;
import 'ui/theme.dart';
import 'ui/widgets.dart';

part 'settings_extensions.dart';
part 'settings_git.dart';

/// Native settings share the web app's API and role permissions.
Future<void> showSettings(BuildContext context, TaskController c) =>
    Navigator.of(context).push<void>(
      MaterialPageRoute(builder: (_) => _SettingsHub(controller: c)),
    );

Future<void> _push(BuildContext context, Widget page) =>
    Navigator.of(context).push<void>(MaterialPageRoute(builder: (_) => page));

Future<void> showProjectsSettings(BuildContext context, TaskController c) =>
    _push(context, _ProjectsSettings(controller: c));

Future<void> showAgentsSettings(BuildContext context, TaskController c) =>
    _push(context, _AgentsSettings(controller: c));

Future<void> showUsersSettings(BuildContext context, TaskController c) =>
    _push(context, _UsersSettings(controller: c));

Future<void> showCredentialsSettings(BuildContext context, TaskController c) =>
    _push(context, _CredentialsSettings(controller: c));

Future<void> showExtensionsSettings(BuildContext context, TaskController c) =>
    _push(context, _ExtensionsSettings(controller: c));

Future<void> showGitSettings(BuildContext context, TaskController c) =>
    _push(context, _GitSettings(controller: c));

const _swatches = [
  '#6366f1',
  '#0ea5e9',
  '#14b8a6',
  '#22c55e',
  '#eab308',
  '#f97316',
  '#ef4444',
  '#ec4899',
  '#a855f7',
  '#64748b',
];
const _categories = ['open', 'active', 'closed'];
const _efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const _permissionModes = [
  'bypassPermissions',
  'auto',
  'acceptEdits',
  'dontAsk',
];

Color _hex(String value) {
  final parsed = int.tryParse(value.replaceFirst('#', ''), radix: 16);
  return parsed == null ? Palette.slateDeep : Color(0xff000000 | parsed);
}

// ---------------------------------------------------------------- scaffolding

class _Screen extends StatelessWidget {
  final String title;
  final String? subtitle;
  final Widget body;
  final Widget? action;
  const _Screen({
    required this.title,
    required this.body,
    this.subtitle,
    this.action,
  });
  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: Palette.bg,
    body: SafeArea(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 760),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.all(16),
                child: Row(
                  children: [
                    IconAction(
                      icon: Icons.arrow_back_rounded,
                      tooltip: 'Back',
                      onPressed: () => Navigator.maybePop(context),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 22,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          if (subtitle != null)
                            Text(
                              subtitle!,
                              style: const TextStyle(
                                fontSize: 12,
                                color: Palette.fgSubtle,
                              ),
                            ),
                        ],
                      ),
                    ),
                    ?action,
                  ],
                ),
              ),
              const Divider(),
              Expanded(child: body),
            ],
          ),
        ),
      ),
    ),
  );
}

class _Item extends StatelessWidget {
  final Widget? leading;
  final String title;
  final String? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;
  const _Item({
    required this.title,
    this.subtitle,
    this.leading,
    this.trailing,
    this.onTap,
  });
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Pressable(
      onTap: onTap,
      padding: const EdgeInsets.all(14),
      color: Palette.surface,
      border: Border.all(color: Palette.border),
      child: Row(
        children: [
          if (leading != null) ...[leading!, const SizedBox(width: 12)],
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
                if (subtitle != null && subtitle!.isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(
                    subtitle!,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 12,
                      color: Palette.fgSubtle,
                    ),
                  ),
                ],
              ],
            ),
          ),
          ?trailing,
          if (onTap != null && trailing == null)
            const Icon(
              Icons.chevron_right_rounded,
              color: Palette.fgSubtle,
              size: 20,
            ),
        ],
      ),
    ),
  );
}

Widget _swatch(String color, {double size = 18}) => Container(
  width: size,
  height: size,
  decoration: BoxDecoration(color: _hex(color), shape: BoxShape.circle),
);

/// Loads data once, shows the failure with a retry, and rebuilds on [reload].
class _Remote<T> extends StatefulWidget {
  final Future<T> Function() load;
  final Widget Function(BuildContext, T, Future<void> Function() reload)
  builder;
  const _Remote({required this.load, required this.builder});
  @override
  State<_Remote<T>> createState() => _RemoteState<T>();
}

class _RemoteState<T> extends State<_Remote<T>> {
  T? data;
  Object? error;
  @override
  void initState() {
    super.initState();
    unawaited(reload());
  }

  Future<void> reload() async {
    try {
      final value = await widget.load();
      if (mounted) {
        setState(() {
          data = value;
          error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = e);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (data != null) {
      return RefreshIndicator(
        onRefresh: reload,
        child: Column(
          children: [
            if (error != null)
              Notice(
                message: error.toString(),
                color: Palette.danger,
                icon: Icons.error_outline_rounded,
              ),
            Expanded(child: widget.builder(context, data as T, reload)),
          ],
        ),
      );
    }
    if (error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Notice(
                message: error.toString(),
                color: Palette.danger,
                icon: Icons.error_outline_rounded,
              ),
              const SizedBox(height: 12),
              AppButton(
                label: 'Retry',
                tone: Tone.secondary,
                onPressed: () {
                  setState(() => error = null);
                  unawaited(reload());
                },
              ),
            ],
          ),
        ),
      );
    }
    return const Center(child: Spinner());
  }
}

ListView _list(List<Widget> children) => ListView(
  physics: const AlwaysScrollableScrollPhysics(),
  padding: const EdgeInsets.all(12),
  children: children,
);

// --------------------------------------------------------------------- forms

sealed class _Field {
  final String key, label;
  const _Field(this.key, this.label);
}

class _Text extends _Field {
  final String initial;
  final int lines;
  final bool secret, required;
  final String? hint;
  const _Text(
    super.key,
    super.label, {
    this.initial = '',
    this.lines = 1,
    this.secret = false,
    this.required = false,
    this.hint,
  });
}

class _Choice extends _Field {
  final String initial;
  final List<(String, String)> options;
  const _Choice(super.key, super.label, this.options, this.initial);
}

class _Toggle extends _Field {
  final bool initial;
  const _Toggle(super.key, super.label, this.initial);
}

class _Color extends _Field {
  final String initial;
  const _Color(super.key, super.label, this.initial);
}

class _MultiChoice extends _Field {
  final List<(String, String)> options;
  final List<String> initial;
  const _MultiChoice(super.key, super.label, this.options, this.initial);
}

class _KeyValues extends _Field {
  final Json initial;
  const _KeyValues(super.key, super.label, this.initial);
}

typedef _Values = Map<String, Object?>;

Future<void> _form(
  BuildContext context, {
  required String title,
  String? subtitle,
  required List<_Field> fields,
  required String submit,
  required Future<void> Function(_Values values) onSubmit,
  List<Widget> Function(BuildContext sheet)? extra,
  bool Function(_Field field, _Values values)? visible,
}) => showAppSheet<void>(
  context,
  maxWidth: 580,
  builder: (_) => _FormSheet(
    title: title,
    subtitle: subtitle,
    fields: fields,
    submit: submit,
    onSubmit: onSubmit,
    extra: extra,
    visible: visible,
  ),
);

class _FormSheet extends StatefulWidget {
  final String title, submit;
  final String? subtitle;
  final List<_Field> fields;
  final Future<void> Function(_Values) onSubmit;
  final List<Widget> Function(BuildContext)? extra;
  final bool Function(_Field, _Values)? visible;
  const _FormSheet({
    required this.title,
    required this.fields,
    required this.submit,
    required this.onSubmit,
    this.subtitle,
    this.extra,
    this.visible,
  });
  @override
  State<_FormSheet> createState() => _FormSheetState();
}

class _FormSheetState extends State<_FormSheet> {
  late final Map<String, TextEditingController> texts = {
    for (final f in widget.fields.whereType<_Text>())
      f.key: TextEditingController(text: f.initial),
  };
  late final _Values values = {
    for (final f in widget.fields)
      f.key: switch (f) {
        _Choice() => f.initial,
        _Toggle() => f.initial,
        _Color() => f.initial,
        _Text() => null,
        _MultiChoice() => [...f.initial],
        _KeyValues() => [
          for (final entry in f.initial.entries)
            {
              'key': entry.key,
              'savedKey': entry.key,
              ...entry.value as Json,
              'identity': Object(),
            },
        ],
      },
  };
  String? error;
  bool saving = false;
  @override
  void dispose() {
    for (final t in texts.values) {
      t.dispose();
    }
    super.dispose();
  }

  Iterable<_Field> get visibleFields =>
      widget.fields.where((f) => widget.visible?.call(f, values) ?? true);

  bool get valid => visibleFields.whereType<_Text>().every(
    (f) => !f.required || texts[f.key]!.text.trim().isNotEmpty,
  );

  Future<void> submit() async {
    setState(() {
      saving = true;
      error = null;
    });
    try {
      await widget.onSubmit({
        ...values,
        for (final e in texts.entries) e.key: e.value.text,
      });
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
    title: widget.title,
    subtitle: widget.subtitle,
    body: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (error != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Notice(
              message: error!,
              color: Palette.danger,
              icon: Icons.error_outline_rounded,
            ),
          ),
        for (final f in visibleFields)
          Padding(
            padding: const EdgeInsets.only(bottom: 14),
            child: switch (f) {
              _Text() => Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  FieldLabel(f.label),
                  if (f.hint != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text(
                        f.hint!,
                        style: const TextStyle(
                          fontSize: 12,
                          color: Palette.fgSubtle,
                        ),
                      ),
                    ),
                  TextField(
                    decoration: InputDecoration(labelText: f.label),
                    controller: texts[f.key],
                    enabled: !saving,
                    obscureText: f.secret,
                    minLines: f.lines,
                    maxLines: f.secret ? 1 : f.lines,
                    autocorrect: !f.secret,
                    enableSuggestions: !f.secret,
                    onChanged: (_) => setState(() {}),
                  ),
                ],
              ),
              _Choice() => Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  FieldLabel(f.label),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final (value, label) in f.options)
                        ChoiceChipX(
                          label: label,
                          selected: values[f.key] == value,
                          onChanged: saving
                              ? null
                              : (_) => setState(() => values[f.key] = value),
                        ),
                    ],
                  ),
                ],
              ),
              _MultiChoice() => Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  FieldLabel(f.label),
                  if (f.options.isEmpty)
                    const Text('No entries in the shared catalog.'),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final (id, label) in f.options)
                        ChoiceChipX(
                          label: label,
                          selected: (values[f.key] as List<String>).contains(
                            id,
                          ),
                          onChanged: saving
                              ? null
                              : (_) {
                                  final selected =
                                      values[f.key] as List<String>;
                                  setState(
                                    () => values[f.key] = selected.contains(id)
                                        ? selected
                                              .where((v) => v != id)
                                              .toList()
                                        : [...selected, id],
                                  );
                                },
                        ),
                    ],
                  ),
                ],
              ),
              _KeyValues() => _McpValuesEditor(
                key: ValueKey(f.key),
                label: f.label,
                read: () => values[f.key] as List<Json>,
                enabled: !saving,
                onChanged: (rows) => setState(() => values[f.key] = rows),
              ),
              _Toggle() => Row(
                children: [
                  Expanded(child: Text(f.label)),
                  Switch(
                    value: values[f.key] as bool,
                    onChanged: saving
                        ? null
                        : (v) => setState(() => values[f.key] = v),
                  ),
                ],
              ),
              _Color() => Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  FieldLabel(f.label),
                  Wrap(
                    spacing: 10,
                    runSpacing: 10,
                    children: [
                      for (final color in {
                        ..._swatches,
                        f.initial.toLowerCase(),
                      })
                        Pressable(
                          onTap: saving
                              ? null
                              : () => setState(() => values[f.key] = color),
                          borderRadius: BorderRadius.circular(99),
                          semanticLabel: 'Color $color',
                          child: Container(
                            padding: const EdgeInsets.all(3),
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              border: Border.all(
                                color: values[f.key] == color
                                    ? Palette.fg
                                    : Colors.transparent,
                                width: 2,
                              ),
                            ),
                            child: _swatch(color, size: 24),
                          ),
                        ),
                    ],
                  ),
                ],
              ),
            },
          ),
        ...?widget.extra?.call(context),
        const SizedBox(height: 10),
        AppButton(
          label: widget.submit,
          busy: saving,
          onPressed: saving || !valid ? null : submit,
        ),
      ],
    ),
  );
}

/// Runs [action] and reports failure as a toast; true when it succeeded.
Future<bool> _run(BuildContext context, Future<void> Function() action) async {
  try {
    await action();
    return true;
  } catch (e) {
    if (context.mounted) toast(context, e.toString());
    return false;
  }
}

// ----------------------------------------------------------------------- hub

class _SettingsHub extends StatelessWidget {
  final TaskController controller;
  const _SettingsHub({required this.controller});
  @override
  Widget build(BuildContext context) {
    final c = controller, admin = c.user?.isAdmin ?? false;
    void open(Widget page) =>
        Navigator.of(context)
            .push<void>(MaterialPageRoute(builder: (_) => page));
    return _Screen(
      title: 'Settings',
      subtitle: c.user?.email,
      body: _list([
        const SectionLabel('Workspace'),
        _Item(
          leading: const Icon(
            Icons.folder_open_outlined,
            color: Palette.primary,
          ),
          title: 'Projects',
          subtitle: 'Details, Statuses, Tags and archiving',
          onTap: () => open(_ProjectsSettings(controller: c)),
        ),
        _Item(
          leading: const Icon(Icons.smart_toy_outlined, color: Palette.agent),
          title: 'Agents',
          subtitle: admin
              ? 'Create and configure Agents'
              : 'Only Admins can change Agents',
          onTap: () => open(_AgentsSettings(controller: c)),
        ),
        if (admin) ...[
          const SizedBox(height: 8),
          const SectionLabel('Administration'),
          _Item(
            leading: const Icon(Icons.group_outlined, color: Palette.info),
            title: 'Users',
            subtitle: 'Accounts, roles and temporary passwords',
            onTap: () => open(_UsersSettings(controller: c)),
          ),
          _Item(
            leading: const Icon(Icons.key_outlined, color: Palette.warning),
            title: 'Credentials',
            subtitle: 'Claude tokens and API keys used by Agents',
            onTap: () => open(_CredentialsSettings(controller: c)),
          ),
          _Item(
            leading: const Icon(Icons.extension_outlined, color: Palette.agent),
            title: 'Extensions',
            subtitle: 'Shared Skills, MCP Servers and Plugins',
            onTap: () => open(_ExtensionsSettings(controller: c)),
          ),
          _Item(
            leading: const Icon(Icons.code_rounded, color: Palette.info),
            title: 'Git Connections',
            subtitle: 'GitHub Apps and GitLab instances',
            onTap: () => open(_GitSettings(controller: c)),
          ),
        ],
        const SizedBox(height: 8),
        const Padding(
          padding: EdgeInsets.all(8),
          child: Text(
            'Dockerfiles, builds and Project secret variables are managed in the web app.',
            style: TextStyle(fontSize: 12, color: Palette.fgSubtle),
          ),
        ),
      ]),
    );
  }
}

// ------------------------------------------------------------------ projects

class _ProjectsSettings extends StatelessWidget {
  final TaskController controller;
  const _ProjectsSettings({required this.controller});
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) => _Screen(
      title: 'Projects',
      action: IconAction(
        icon: Icons.add_rounded,
        tooltip: 'New project',
        onPressed: () => _form(
          context,
          title: 'New project',
          subtitle: 'The key is 2–6 uppercase letters and cannot change later',
          fields: const [
            _Text('key', 'Key', required: true),
            _Text('name', 'Name', required: true),
            _Text('description', 'Description', lines: 3),
          ],
          submit: 'Create project',
          onSubmit: (v) async {
            await controller.settingsRequest(
              'POST',
              '/projects',
              body: {
                'key': (v['key'] as String).trim().toUpperCase(),
                'name': (v['name'] as String).trim(),
                'description': v['description'],
              },
            );
            await controller.refresh();
          },
        ),
      ),
      body: _list([
        if (controller.projects.isEmpty)
          const Padding(
            padding: EdgeInsets.all(24),
            child: Text(
              'No projects yet.',
              style: TextStyle(color: Palette.fgSubtle),
            ),
          ),
        for (final p in controller.projects)
          _Item(
            title: p.name,
            subtitle: '${p.key} · ${p.taskTotal} tasks',
            onTap: () => Navigator.of(context).push<void>(
              MaterialPageRoute(
                builder: (_) =>
                    _ProjectSettings(controller: controller, project: p),
              ),
            ),
          ),
      ]),
    ),
  );
}

class _ProjectSettings extends StatelessWidget {
  final TaskController controller;
  final Project project;
  const _ProjectSettings({required this.controller, required this.project});
  @override
  Widget build(BuildContext context) {
    final c = controller;
    return _Screen(
      title: '${project.name} settings',
      subtitle: project.key,
      body: _Remote<Json>(
        load: () => c.settingsRequest('GET', '/projects/${project.id}'),
        builder: (context, bundle, reload) {
          final info = bundle['project'] as Json;
          final archived = info['archivedAt'] != null;
          final statuses = objects(bundle['statuses'])
            ..sort(
              (a, b) => ((a['position'] as num?) ?? 0).compareTo(
                (b['position'] as num?) ?? 0,
              ),
            );
          final tags = objects(bundle['tags']);
          Future<void> change(String method, String path, [Json? body]) async {
            await c.settingsRequest(method, path, body: body);
            await reload();
            unawaited(c.refresh().catchError((Object _) {}));
          }

          Future<void> reorder(int i, int j) => _run(context, () {
            final ids = [for (final s in statuses) s['id'] as String];
            final t = ids[i];
            ids[i] = ids[j];
            ids[j] = t;
            return change('PUT', '/projects/${project.id}/statuses/order', {
              'statusIds': ids,
            });
          });
          return _list([
            const SectionLabel('Details'),
            _Item(
              title: info['name'] as String,
              subtitle: (info['description'] as String?) ?? '',
              trailing: const Icon(
                Icons.edit_outlined,
                size: 18,
                color: Palette.fgSubtle,
              ),
              onTap: () => _form(
                context,
                title: 'Project details',
                subtitle: project.key,
                fields: [
                  _Text(
                    'name',
                    'Name',
                    initial: info['name'] as String,
                    required: true,
                  ),
                  _Text(
                    'description',
                    'Description',
                    initial: (info['description'] as String?) ?? '',
                    lines: 3,
                  ),
                ],
                submit: 'Save changes',
                onSubmit: (v) => change('PATCH', '/projects/${project.id}', {
                  'name': (v['name'] as String).trim(),
                  'description': v['description'],
                }),
              ),
            ),
            Row(
              children: [
                AppButton(
                  label: archived ? 'Unarchive' : 'Archive',
                  icon: archived
                      ? Icons.unarchive_outlined
                      : Icons.archive_outlined,
                  tone: Tone.secondary,
                  onPressed: () => _run(
                    context,
                    () => change(
                      'POST',
                      '/projects/${project.id}/${archived ? 'unarchive' : 'archive'}',
                    ),
                  ),
                ),
                if (archived && (c.user?.isAdmin ?? false)) ...[
                  const SizedBox(width: 8),
                  AppButton(
                    label: 'Delete permanently',
                    tone: Tone.danger,
                    onPressed: () async {
                      if (!await confirm(
                        context,
                        title: 'Delete ${project.key} permanently?',
                        message: 'All its tasks, comments and attachments are deleted. This cannot be undone.',
                        confirmLabel: 'Delete project',
                      )) {
                        return;
                      }
                      if (!context.mounted) return;
                      final nav = Navigator.of(context);
                      final ok = await _run(context, () async {
                        await c.settingsRequest(
                          'DELETE',
                          '/projects/${project.id}',
                        );
                        await c.refresh();
                      });
                      if (ok) nav.pop();
                    },
                  ),
                ],
              ],
            ),
            const SizedBox(height: 20),
            Row(
              children: [
                const Expanded(child: SectionLabel('Statuses')),
                IconAction(
                  icon: Icons.add_rounded,
                  tooltip: 'Add status',
                  onPressed: () => _form(
                    context,
                    title: 'New status',
                    fields: [
                      const _Text('name', 'Name', required: true),
                      const _Color('color', 'Color', '#64748b'),
                      _Choice('category', 'Category', [
                        for (final k in _categories) (k, k),
                      ], 'active'),
                    ],
                    submit: 'Add status',
                    onSubmit: (v) =>
                        change('POST', '/projects/${project.id}/statuses', {
                          'name': (v['name'] as String).trim(),
                          'color': v['color'],
                          'category': v['category'],
                        }),
                  ),
                ),
              ],
            ),
            const Padding(
              padding: EdgeInsets.only(bottom: 8, left: 2),
              child: Text(
                'A project keeps at least one open and one closed status.',
                style: TextStyle(fontSize: 12, color: Palette.fgSubtle),
              ),
            ),
            for (final (i, s) in statuses.indexed)
              _Item(
                leading: _swatch(s['color'] as String),
                title: s['name'] as String,
                subtitle: s['category'] as String,
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    IconAction(
                      icon: Icons.arrow_upward_rounded,
                      tooltip: 'Move ${s['name']} up',
                      onPressed: i == 0 ? null : () => reorder(i, i - 1),
                    ),
                    IconAction(
                      icon: Icons.arrow_downward_rounded,
                      tooltip: 'Move ${s['name']} down',
                      onPressed: i == statuses.length - 1
                          ? null
                          : () => reorder(i, i + 1),
                    ),
                  ],
                ),
                onTap: () => _form(
                  context,
                  title: 'Edit status',
                  fields: [
                    _Text(
                      'name',
                      'Name',
                      initial: s['name'] as String,
                      required: true,
                    ),
                    _Color('color', 'Color', s['color'] as String),
                    _Choice('category', 'Category', [
                      for (final k in _categories) (k, k),
                    ], s['category'] as String),
                  ],
                  submit: 'Save status',
                  onSubmit: (v) => change('PATCH', '/statuses/${s['id']}', {
                    'name': (v['name'] as String).trim(),
                    'color': v['color'],
                    'category': v['category'],
                  }),
                  extra: (sheet) => [
                    AppButton(
                      label: 'Delete status',
                      tone: Tone.danger,
                      onPressed: statuses.length < 2
                          ? null
                          : () async {
                              final others = [
                                for (final o in statuses)
                                  if (o['id'] != s['id']) o,
                              ];
                              final target = await showPicker<String>(
                                sheet,
                                title: 'Move its tasks to',
                                selected: others.first['id'] as String,
                                options: [
                                  for (final o in others)
                                    PickerOption(
                                      o['id'] as String,
                                      o['name'] as String,
                                      detail: o['category'] as String,
                                    ),
                                ],
                              );
                              if (target == null || !sheet.mounted) return;
                              final nav = Navigator.of(sheet);
                              if (await _run(
                                sheet,
                                () => change(
                                  'DELETE',
                                  '/statuses/${s['id']}?targetStatusId=$target',
                                ),
                              )) {
                                nav.pop();
                              }
                            },
                    ),
                  ],
                ),
              ),
            const SizedBox(height: 20),
            Row(
              children: [
                const Expanded(child: SectionLabel('Tags')),
                IconAction(
                  icon: Icons.add_rounded,
                  tooltip: 'Add tag',
                  onPressed: () => _form(
                    context,
                    title: 'New tag',
                    fields: const [
                      _Text('name', 'Name', required: true),
                      _Color('color', 'Color', '#6366f1'),
                    ],
                    submit: 'Add tag',
                    onSubmit: (v) =>
                        change('POST', '/projects/${project.id}/tags', {
                          'name': (v['name'] as String).trim(),
                          'color': v['color'],
                        }),
                  ),
                ),
              ],
            ),
            if (tags.isEmpty)
              const Padding(
                padding: EdgeInsets.all(8),
                child: Text(
                  'No tags yet.',
                  style: TextStyle(color: Palette.fgSubtle),
                ),
              ),
            for (final t in tags)
              _Item(
                leading: _swatch((t['color'] as String?) ?? '#64748b'),
                title: t['name'] as String,
                onTap: () => _form(
                  context,
                  title: 'Edit tag',
                  fields: [
                    _Text(
                      'name',
                      'Name',
                      initial: t['name'] as String,
                      required: true,
                    ),
                    _Color(
                      'color',
                      'Color',
                      (t['color'] as String?) ?? '#6366f1',
                    ),
                  ],
                  submit: 'Save tag',
                  onSubmit: (v) => change('PATCH', '/tags/${t['id']}', {
                    'name': (v['name'] as String).trim(),
                    'color': v['color'],
                  }),
                  extra: (sheet) => [
                    AppButton(
                      label: 'Delete tag',
                      tone: Tone.danger,
                      onPressed: () async {
                        if (!await confirm(
                          sheet,
                          title: 'Delete tag “${t['name']}”?',
                          message: 'It is removed from every task.',
                          confirmLabel: 'Delete tag',
                        )) {
                          return;
                        }
                        if (!sheet.mounted) return;
                        final nav = Navigator.of(sheet);
                        if (await _run(
                          sheet,
                          () => change('DELETE', '/tags/${t['id']}'),
                        )) {
                          nav.pop();
                        }
                      },
                    ),
                  ],
                ),
              ),
            const SizedBox(height: 20),
            _Item(
              title: 'Repository',
              subtitle: 'Repository, Base Branch and protection',
              leading: const Icon(Icons.code_rounded, color: Palette.info),
              onTap: () => _push(
                context,
                _RepositorySettings(controller: c, project: project),
              ),
            ),
          ]);
        },
      ),
    );
  }
}

// -------------------------------------------------------------------- agents

class _AgentsSettings extends StatelessWidget {
  final TaskController controller;
  const _AgentsSettings({required this.controller});
  @override
  Widget build(BuildContext context) {
    final c = controller, admin = c.user?.isAdmin ?? false;
    return _Remote<
      (List<Json>, List<Json>, List<Json>, List<Json>, List<Json>)
    >(
      load: () async {
        final results = await Future.wait([
          c.settingsRequest('GET', '/agents'),
          if (admin) ...[
            c.settingsRequest('GET', '/credentials'),
            c.settingsRequest('GET', '/skills'),
            c.settingsRequest('GET', '/mcp-servers'),
            c.settingsRequest('GET', '/plugins'),
          ],
        ]);
        return (
          objects(results[0]['agents']),
          admin ? objects(results[1]['credentials']) : <Json>[],
          admin ? objects(results[2]['skills']) : <Json>[],
          admin ? objects(results[3]['mcpServers']) : <Json>[],
          admin ? objects(results[4]['plugins']) : <Json>[],
        );
      },
      builder: (context, data, reload) {
        final (agents, credentials, skills, mcpServers, plugins) = data;
        Future<void> change(String method, String path, [Json? body]) async {
          await c.settingsRequest(method, path, body: body);
          await reload();
          unawaited(c.refresh().catchError((Object _) {}));
        }

        List<_Field> fields(Json? a) => [
          _Text(
            'name',
            'Name',
            initial: (a?['name'] as String?) ?? '',
            required: true,
          ),
          _Text(
            'avatarEmoji',
            'Emoji',
            initial: (a?['avatarEmoji'] as String?) ?? '🤖',
            required: true,
          ),
          _Color(
            'avatarColor',
            'Color',
            (a?['avatarColor'] as String?) ?? '#6366f1',
          ),
          _Text(
            'description',
            'Description',
            initial: (a?['description'] as String?) ?? '',
            lines: 2,
          ),
          if (credentials.isNotEmpty)
            _Choice(
              'credentialId',
              'Credential',
              [
                for (final k in credentials)
                  (k['id'] as String, k['name'] as String),
              ],
              (a?['credentialId'] as String?) ??
                  credentials.first['id'] as String,
            ),
          _Text(
            'model',
            'Model',
            initial: (a?['model'] as String?) ?? '',
            hint: 'blank = default',
          ),
          _Choice('effort', 'Effort', [
            ('', 'default'),
            for (final e in _efforts) (e, e),
          ], (a?['effort'] as String?) ?? ''),
          _Choice('permissionMode', 'Permission mode', [
            for (final m in _permissionModes) (m, m),
          ], (a?['permissionMode'] as String?) ?? 'bypassPermissions'),
          _Text(
            'systemPrompt',
            'System prompt',
            initial: (a?['systemPrompt'] as String?) ?? '',
            lines: 5,
          ),
          _Toggle('enabled', 'Enabled', a?['enabled'] != false),
          for (final (key, label, entries) in [
            ('skillIds', 'Skills', skills),
            ('mcpServerIds', 'MCP Servers', mcpServers),
            ('pluginIds', 'Plugins', plugins),
          ])
            _MultiChoice(key, label, [
              for (final entry in entries)
                (entry['id'] as String, entry['name'] as String),
            ], List<String>.from(a?[key] as List? ?? const [])),
        ];
        Json body(_Values v, [Json? previous]) => {
          'name': (v['name'] as String).trim(),
          'avatarEmoji': (v['avatarEmoji'] as String).trim(),
          'avatarColor': v['avatarColor'],
          'description': v['description'],
          'credentialId': ?v['credentialId'],
          'model': (v['model'] as String).trim().isEmpty
              ? null
              : (v['model'] as String).trim(),
          'effort': (v['effort'] as String).isEmpty ? null : v['effort'],
          'permissionMode': v['permissionMode'],
          'systemPrompt': v['systemPrompt'],
          'enabled': v['enabled'],
          for (final key in ['skillIds', 'mcpServerIds', 'pluginIds'])
            if (previous == null ||
                !_sameSelection(
                  v[key] as List<String>,
                  List<String>.from(previous[key] as List? ?? const []),
                ))
              key: v[key],
        };
        return _Screen(
          title: 'Agents',
          action: admin
              ? IconAction(
                  icon: Icons.add_rounded,
                  tooltip: 'New agent',
                  onPressed: credentials.isEmpty
                      ? () => toast(context, 'Create a Credential first')
                      : () => _form(
                          context,
                          title: 'New agent',
                          subtitle: 'Starts from the default Dockerfile; edit it in the web app',
                          fields: fields(null),
                          submit: 'Create agent',
                          onSubmit: (v) => change('POST', '/agents', {
                            ...body(v),
                            'dockerfile':
                                'FROM claude-task/agent-base\nUSER agent\n',
                          }),
                        ),
                )
              : null,
          body: RefreshIndicator(
            onRefresh: reload,
            child: _list([
              for (final a in agents) ...[
                _AgentExtensionStatus(controller: c, agent: a),
                _Item(
                  leading: Text(
                    (a['avatarEmoji'] as String?) ?? '🤖',
                    style: const TextStyle(fontSize: 24),
                  ),
                  title: a['name'] as String,
                  subtitle:
                      '${a['state']} · ${a['credentialName'] ?? ''} · queue ${a['queueLength'] ?? 0}',
                  onTap: !admin
                      ? null
                      : () => _form(
                          context,
                          title: 'Edit agent',
                          subtitle: a['name'] as String,
                          fields: fields(a),
                          submit: 'Save agent',
                          onSubmit: (v) =>
                              change('PATCH', '/agents/${a['id']}', body(v, a)),
                          extra: (sheet) => [
                            AppButton(
                              label: 'Manage shared Extensions',
                              tone: Tone.secondary,
                              onPressed: () async {
                                Navigator.pop(sheet);
                                await _push(
                                  context,
                                  _ExtensionsSettings(controller: c),
                                );
                                await reload();
                              },
                            ),
                            const SizedBox(height: 8),
                            AppButton(
                              label: 'Duplicate',
                              tone: Tone.secondary,
                              onPressed: () async {
                                final nav = Navigator.of(sheet);
                                if (await _run(
                                  sheet,
                                  () => change(
                                    'POST',
                                    '/agents/${a['id']}/duplicate',
                                    {},
                                  ),
                                )) {
                                  nav.pop();
                                }
                              },
                            ),
                            const SizedBox(height: 8),
                            AppButton(
                              label: 'Delete agent',
                              tone: Tone.danger,
                              onPressed: () async {
                                if (!await confirm(
                                  sheet,
                                  title: 'Delete ${a['name']}?',
                                  message:
                                      'Its container and image are removed.',
                                  confirmLabel: 'Delete agent',
                                )) {
                                  return;
                                }
                                if (!sheet.mounted) return;
                                final nav = Navigator.of(sheet);
                                if (await _run(
                                  sheet,
                                  () => change('DELETE', '/agents/${a['id']}'),
                                )) {
                                  nav.pop();
                                }
                              },
                            ),
                          ],
                        ),
                ),
              ],
            ]),
          ),
        );
      },
    );
  }
}

// --------------------------------------------------------------------- users

class _UsersSettings extends StatelessWidget {
  final TaskController controller;
  const _UsersSettings({required this.controller});

  Future<void> _showPassword(BuildContext context, String password) =>
      showAppSheet<void>(
        context,
        maxWidth: 420,
        builder: (sheet) => SheetScaffold(
          title: 'Temporary password',
          subtitle: 'Shown once. The User must change it at sign-in.',
          body: SelectableText(
            password,
            style: const TextStyle(fontFamily: 'GeistMono', fontSize: 18),
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final c = controller;
    return _Remote<List<Json>>(
      load: () async =>
          objects((await c.settingsRequest('GET', '/users'))['users']),
      builder: (context, users, reload) {
        Future<Json> change(String method, String path, Json? body) async {
          final result = await c.settingsRequest(method, path, body: body);
          await reload();
          unawaited(c.refresh().catchError((Object _) {}));
          return result;
        }

        return _Screen(
          title: 'Users',
          action: IconAction(
            icon: Icons.person_add_alt_1_outlined,
            tooltip: 'New user',
            onPressed: () => _form(
              context,
              title: 'New user',
              subtitle: 'A temporary password is generated when left blank',
              fields: const [
                _Text('email', 'Email', required: true),
                _Text('displayName', 'Name', required: true),
                _Choice('role', 'Role', [
                  ('member', 'member'),
                  ('admin', 'admin'),
                ], 'member'),
                _Text(
                  'password',
                  'Temporary password',
                  secret: true,
                  hint: 'optional, 8+ characters',
                ),
              ],
              submit: 'Create user',
              onSubmit: (v) async {
                final password = (v['password'] as String);
                final result = await change('POST', '/users', {
                  'email': (v['email'] as String).trim(),
                  'displayName': (v['displayName'] as String).trim(),
                  'role': v['role'],
                  if (password.isNotEmpty) 'temporaryPassword': password,
                });
                if (context.mounted) {
                  unawaited(
                    _showPassword(
                      context,
                      result['temporaryPassword'] as String? ?? password,
                    ),
                  );
                }
              },
            ),
          ),
          body: _list([
            for (final u in users)
              _Item(
                title: u['displayName'] as String? ?? '',
                subtitle:
                    '${u['email']} · ${u['role']}${u['active'] == false ? ' · deactivated' : ''}',
                onTap: () => _form(
                  context,
                  title: 'Edit user',
                  subtitle: u['email'] as String?,
                  fields: [
                    _Text(
                      'displayName',
                      'Name',
                      initial: u['displayName'] as String? ?? '',
                      required: true,
                    ),
                    _Choice('role', 'Role', [
                      ('member', 'member'),
                      ('admin', 'admin'),
                    ], u['role'] as String? ?? 'member'),
                    _Toggle('active', 'Active', u['active'] != false),
                  ],
                  submit: 'Save user',
                  onSubmit: (v) async {
                    await change('PATCH', '/users/${u['id']}', {
                      'displayName': (v['displayName'] as String).trim(),
                      'role': v['role'],
                      'active': v['active'],
                    });
                  },
                  extra: (sheet) => [
                    AppButton(
                      label: 'Reset password',
                      tone: Tone.secondary,
                      onPressed: () async {
                        if (!await confirm(
                          sheet,
                          title: 'Reset password?',
                          message: 'Signs the User out everywhere and generates a temporary password.',
                          confirmLabel: 'Reset password',
                        )) {
                          return;
                        }
                        if (!sheet.mounted) return;
                        final nav = Navigator.of(sheet);
                        String? password;
                        final ok = await _run(sheet, () async {
                          final r = await change(
                            'POST',
                            '/users/${u['id']}/reset-password',
                            null,
                          );
                          password = r['temporaryPassword'] as String?;
                        });
                        if (!ok) return;
                        nav.pop();
                        if (password != null && context.mounted) {
                          unawaited(_showPassword(context, password!));
                        }
                      },
                    ),
                  ],
                ),
              ),
          ]),
        );
      },
    );
  }
}

// ---------------------------------------------------------------- credentials

class _CredentialsSettings extends StatelessWidget {
  final TaskController controller;
  const _CredentialsSettings({required this.controller});
  @override
  Widget build(BuildContext context) {
    final c = controller;
    const kinds = [
      ('claude_oauth_token', 'Claude token'),
      ('anthropic_api_key', 'API key'),
    ];
    String kindLabel(String? k) =>
        kinds.where((e) => e.$1 == k).firstOrNull?.$2 ?? '$k';
    return _Remote<List<Json>>(
      load: () async => objects(
        (await c.settingsRequest('GET', '/credentials'))['credentials'],
      ),
      builder: (context, credentials, reload) {
        Future<void> change(String method, String path, [Json? body]) async {
          await c.settingsRequest(method, path, body: body);
          await reload();
          unawaited(c.refresh().catchError((Object _) {}));
        }

        return _Screen(
          title: 'Credentials',
          subtitle: 'Secrets are write-only; only the last 4 characters show',
          action: IconAction(
            icon: Icons.add_rounded,
            tooltip: 'New credential',
            onPressed: () => _form(
              context,
              title: 'New credential',
              fields: const [
                _Text('name', 'Name', required: true),
                _Choice('kind', 'Kind', kinds, 'claude_oauth_token'),
                _Text('secret', 'Secret', secret: true, required: true),
              ],
              submit: 'Create credential',
              onSubmit: (v) => change('POST', '/credentials', {
                'name': (v['name'] as String).trim(),
                'kind': v['kind'],
                'secret': (v['secret'] as String).trim(),
              }),
            ),
          ),
          body: _list([
            for (final k in credentials)
              _Item(
                leading: const Icon(Icons.key_outlined, color: Palette.warning),
                title: k['name'] as String,
                subtitle:
                    '${kindLabel(k['kind'] as String?)} · …${k['last4']} · used by ${objects(k['usedBy']).length}',
                onTap: () => _form(
                  context,
                  title: 'Edit credential',
                  subtitle: k['name'] as String,
                  fields: [
                    _Text(
                      'name',
                      'Name',
                      initial: k['name'] as String,
                      required: true,
                    ),
                    const _Text(
                      'secret',
                      'New secret',
                      secret: true,
                      hint: 'leave blank to keep the current one',
                    ),
                  ],
                  submit: 'Save credential',
                  onSubmit: (v) {
                    final secret = (v['secret'] as String).trim();
                    return change('PATCH', '/credentials/${k['id']}', {
                      'name': (v['name'] as String).trim(),
                      if (secret.isNotEmpty) 'secret': secret,
                    });
                  },
                  extra: (sheet) => [
                    AppButton(
                      label: 'Delete credential',
                      tone: Tone.danger,
                      onPressed: () async {
                        if (!await confirm(
                          sheet,
                          title: 'Delete ${k['name']}?',
                          message: objects(k['usedBy']).isEmpty ? null : 'It is still used by Agents; the server may refuse.',
                          confirmLabel: 'Delete credential',
                        )) {
                          return;
                        }
                        if (!sheet.mounted) return;
                        final nav = Navigator.of(sheet);
                        if (await _run(
                          sheet,
                          () => change('DELETE', '/credentials/${k['id']}'),
                        )) {
                          nav.pop();
                        }
                      },
                    ),
                  ],
                ),
              ),
          ]),
        );
      },
    );
  }
}
