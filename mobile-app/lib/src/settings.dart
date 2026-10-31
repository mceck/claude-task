import 'dart:async';
import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:material_ui/material_ui.dart';

import 'controller.dart';
import 'models.dart';
import 'project_env.dart';
import 'task_forms.dart' show agentAvatar, agentFreeDot, openLink;
import 'ui/theme.dart';
import 'ui/widgets.dart';
import 'ui/image_upload.dart';
import 'ui/project_logo.dart';
import 'ui/user_avatar.dart';

part 'settings_extensions.dart';
part 'settings_git.dart';
part 'settings_project_agents.dart';
part 'settings_projects.dart';

/// Native settings share the web app's API and role permissions.
Future<void> showSettings(BuildContext context, TaskController c) =>
    Navigator.of(context).push<void>(
      MaterialPageRoute(builder: (_) => _SettingsHub(controller: c)),
    );

Future<void> _push(BuildContext context, Widget page) =>
    Navigator.of(context).push<void>(MaterialPageRoute(builder: (_) => page));

Future<void> showProjectsSettings(BuildContext context, TaskController c) =>
    _push(context, _ProjectsSettings(controller: c));

Future<void> showProjectSettings(
  BuildContext context,
  TaskController c,
  Project project,
) => _push(context, _ProjectSettings(controller: c, project: project));

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
const _categories = ['backlog', 'open', 'active', 'closed'];
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

Widget _swatch(String color, {double size = 18}) => Container(
  width: size,
  height: size,
  decoration: BoxDecoration(color: _hex(color), shape: BoxShape.circle),
);

typedef _Content = ({List<Widget> actions, Widget body});

/// A settings screen whose data loads on entry. Its header and Back stay
/// usable while loading and after a failure, which offers Retry; pull to
/// refresh reloads, and a failed reload keeps the loaded data visible.
class _RemotePage<T> extends StatefulWidget {
  final String title;
  final String? subtitle;
  final Future<T> Function() load;
  final _Content Function(BuildContext, T, Future<void> Function() reload)
  builder;
  const _RemotePage({
    required this.title,
    required this.load,
    required this.builder,
    this.subtitle,
  });
  @override
  State<_RemotePage<T>> createState() => _RemotePageState<T>();
}

class _RemotePageState<T> extends State<_RemotePage<T>> {
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
    final content = data == null
        ? null
        : widget.builder(context, data as T, reload);
    return AppPage(
      title: widget.title,
      subtitle: widget.subtitle,
      actions: content?.actions ?? const [],
      body: content != null
          ? AppRefresh(
              onRefresh: reload,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (error != null)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(
                        Space.page,
                        12,
                        Space.page,
                        0,
                      ),
                      child: Notice.error(error.toString()),
                    ),
                  Expanded(child: content.body),
                ],
              ),
            )
          : error != null
          ? LoadError(
              error: error!,
              onRetry: () {
                setState(() => error = null);
                unawaited(reload());
              },
            )
          : const Center(child: Spinner()),
    );
  }
}

Widget _list(List<Widget> children) => PageList(children: children);

/// The screen shown to Members on Admin-only settings.
class _AdminOnly extends StatelessWidget {
  final String title;
  const _AdminOnly(this.title);
  @override
  Widget build(BuildContext context) => AppPage(
    title: title,
    body: const EmptyState(
      icon: Icons.lock_outline_rounded,
      title: 'Admin access required.',
      message: 'Ask an Admin to change these settings.',
    ),
  );
}

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
  Widget? header,
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
    header: header,
    visible: visible,
  ),
);

class _FormSheet extends StatefulWidget {
  final String title, submit;
  final String? subtitle;
  final List<_Field> fields;
  final Future<void> Function(_Values) onSubmit;
  final List<Widget> Function(BuildContext)? extra;
  final Widget? header;
  final bool Function(_Field, _Values)? visible;
  const _FormSheet({
    required this.title,
    required this.fields,
    required this.submit,
    required this.onSubmit,
    this.subtitle,
    this.extra,
    this.header,
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
  Widget build(BuildContext context) {
    final extra = widget.extra?.call(context) ?? const [];
    return SheetScaffold(
      title: widget.title,
      subtitle: widget.subtitle,
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Notice.error(error!),
            ),
          ?widget.header,
          for (final f in visibleFields)
            switch (f) {
              _Text() => LabeledField(
                label: f.label,
                description: f.hint,
                child: TextField(
                  controller: texts[f.key],
                  enabled: !saving,
                  obscureText: f.secret,
                  minLines: f.lines,
                  maxLines: f.secret ? 1 : f.lines,
                  autocorrect: !f.secret,
                  enableSuggestions: !f.secret,
                  style: f.lines > 4
                      ? const TextStyle(fontFamily: mono, fontSize: 12.5)
                      : null,
                  onChanged: (_) => setState(() {}),
                ),
              ),
              _Choice() => LabeledField(
                label: f.label,
                child: Wrap(
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
              ),
              _MultiChoice() => LabeledField(
                label: f.label,
                child: f.options.isEmpty
                    ? const EmptyHint('No entries in the shared catalog.')
                    : Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          for (final (id, label) in f.options)
                            ChoiceChipX(
                              label: label,
                              selected: (values[f.key] as List<String>)
                                  .contains(id),
                              onChanged: saving
                                  ? null
                                  : (_) {
                                      final selected =
                                          values[f.key] as List<String>;
                                      setState(
                                        () => values[f.key] =
                                            selected.contains(id)
                                            ? selected
                                                  .where((v) => v != id)
                                                  .toList()
                                            : [...selected, id],
                                      );
                                    },
                            ),
                        ],
                      ),
              ),
              _KeyValues() => _McpValuesEditor(
                key: ValueKey(f.key),
                label: f.label,
                read: () => values[f.key] as List<Json>,
                enabled: !saving,
                onChanged: (rows) => setState(() => values[f.key] = rows),
              ),
              _Toggle() => SwitchRow(
                label: f.label,
                value: values[f.key] as bool,
                onChanged: saving
                    ? null
                    : (v) => setState(() => values[f.key] = v),
              ),
              _Color() => LabeledField(
                label: f.label,
                child: Wrap(
                  spacing: 10,
                  runSpacing: 10,
                  children: [
                    for (final color in {..._swatches, f.initial.toLowerCase()})
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
              ),
            },
          // Secondary and destructive actions on the entry being edited.
          if (extra.isNotEmpty) ...[
            const Divider(height: 24),
            for (final (i, action) in extra.indexed) ...[
              if (i > 0) const SizedBox(height: 8),
              action,
            ],
          ],
        ],
      ),
      actions: [
        AppButton(
          label: 'Cancel',
          tone: Tone.secondary,
          onPressed: saving ? null : () => Navigator.pop(context),
        ),
        AppButton(
          label: widget.submit,
          busy: saving,
          onPressed: saving || !valid ? null : submit,
        ),
      ],
    );
  }
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
    void open(Widget page) => Navigator.of(
      context,
    ).push<void>(MaterialPageRoute(builder: (_) => page));
    return AppPage(
      title: 'Settings',
      subtitle: c.user?.email,
      body: _list([
        Section(
          title: 'Workspace',
          children: [
            AppTile(
              leading: const IconBadge(
                Icons.folder_open_outlined,
                color: Palette.primary,
              ),
              title: 'Projects',
              subtitle: 'Details, Statuses, Tags and archiving',
              onTap: () => open(_ProjectsSettings(controller: c)),
            ),
            AppTile(
              leading: const IconBadge(
                Icons.smart_toy_outlined,
                color: Palette.agent,
              ),
              title: 'Agents',
              subtitle: admin
                  ? 'Create and configure Agents'
                  : 'Only Admins can change Agents',
              onTap: () => open(_AgentsSettings(controller: c)),
            ),
          ],
        ),
        if (admin)
          Section(
            title: 'Administration',
            children: [
              AppTile(
                leading: const IconBadge(
                  Icons.group_outlined,
                  color: Palette.info,
                ),
                title: 'Users',
                subtitle: 'Accounts, roles and temporary passwords',
                onTap: () => open(_UsersSettings(controller: c)),
              ),
              AppTile(
                leading: const IconBadge(
                  Icons.key_outlined,
                  color: Palette.warning,
                ),
                title: 'Credentials',
                subtitle: 'Claude tokens, auth tokens and API keys used by Agents',
                onTap: () => open(_CredentialsSettings(controller: c)),
              ),
              AppTile(
                leading: const IconBadge(
                  Icons.extension_outlined,
                  color: Palette.agent,
                ),
                title: 'Extensions',
                subtitle: 'Shared Skills, MCP Servers and Plugins',
                onTap: () => open(_ExtensionsSettings(controller: c)),
              ),
              AppTile(
                leading: const IconBadge(
                  Icons.code_rounded,
                  color: Palette.info,
                ),
                title: 'Git Connections',
                subtitle: 'GitHub Apps and GitLab instances',
                onTap: () => open(_GitSettings(controller: c)),
              ),
            ],
          ),
        const Text(
          'Dockerfiles, builds and Project secret variables are managed in the web app.',
          style: TextStyle(fontSize: 12, color: Palette.fgSubtle),
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
    builder: (context, _) => AppPage(
      title: 'Projects',
      actions: [
        IconAction(
          icon: Icons.add_rounded,
          tooltip: 'New project',
          filled: true,
          size: 36,
          onPressed: controller.online
              ? () => showProjectForm(context, controller, selectCreated: false)
              : null,
        ),
      ],
      body: controller.projects.isEmpty
          ? const EmptyState(
              icon: Icons.folder_off_outlined,
              title: 'No Projects',
              message: 'Create a Project to organize your Tasks.',
            )
          : _list([
              for (final p in controller.projects)
                AppTile(
                  leading: ProjectLogo(
                    project: p,
                    api: controller.api,
                    size: 32,
                  ),
                  title: p.name,
                  subtitle: '${p.key} · ${p.taskTotal} tasks',
                  onTap: () => showProjectSettings(context, controller, p),
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
    return _RemotePage<Json>(
      title: '${project.name} settings',
      subtitle: project.key,
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
        return (
          actions: const <Widget>[],
          body: _list([
            Section(
              title: 'Details',
              children: [
                ListenableBuilder(
                  listenable: c,
                  builder: (context, _) => ImageUpload(
                    key: ValueKey('project-logo:${project.id}'),
                    title: 'Project logo',
                    uploadLabel: 'Upload logo',
                    replaceLabel: 'Replace logo',
                    removeLabel: 'Remove logo',
                    imageUrl: info['logoUrl'] as String?,
                    enabled: c.online,
                    preview: (url) => ProjectLogo(
                      project: Project.fromJson({...info, 'logoUrl': url}),
                      api: c.api,
                      size: 72,
                    ),
                    onChange: (file) async {
                      final result = await c.settingsRequest(
                        file == null ? 'DELETE' : 'PUT',
                        '/projects/${project.id}/logo',
                        files: file == null ? const [] : [file],
                      );
                      unawaited(c.refresh().catchError((Object _) {}));
                      return (result['project'] as Json)['logoUrl'] as String?;
                    },
                  ),
                ),
                AppTile(
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
                    onSubmit: (v) =>
                        change('PATCH', '/projects/${project.id}', {
                          'name': (v['name'] as String).trim(),
                          'description': v['description'],
                        }),
                  ),
                ),
              ],
            ),
            Section(
              title: 'Statuses',
              description:
                  'A project keeps at least one open and one closed status.',
              trailing: SectionAdd(
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
              children: [
                for (final (i, s) in statuses.indexed)
                  AppTile(
                    leading: _swatch(s['color'] as String),
                    title: s['name'] as String,
                    subtitle: s['category'] as String,
                    trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        IconAction(
                          icon: Icons.arrow_upward_rounded,
                          size: 32,
                          tooltip: 'Move ${s['name']} up',
                          onPressed: i == 0 ? null : () => reorder(i, i - 1),
                        ),
                        IconAction(
                          icon: Icons.arrow_downward_rounded,
                          size: 32,
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
              ],
            ),
            Section(
              title: 'Tags',
              trailing: SectionAdd(
                tooltip: 'Add tag',
                onPressed: () => _form(
                  context,
                  title: 'New tag',
                  fields: const [
                    _Text('name', 'Name', required: true),
                    _Color('color', 'Color', '#6366f1'),
                  ],
                  submit: 'Add tag',
                  onSubmit: (v) => change(
                    'POST',
                    '/projects/${project.id}/tags',
                    {'name': (v['name'] as String).trim(), 'color': v['color']},
                  ),
                ),
              ),
              children: [
                if (tags.isEmpty) const EmptyHint('No tags yet.'),
                for (final t in tags)
                  AppTile(
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
              ],
            ),
            Section(
              title: 'Agents and code',
              children: [
                AppTile(
                  title: 'Agent setup',
                  subtitle:
                      'Default Agent, Setup Script, instructions and environment',
                  leading: const IconBadge(
                    Icons.smart_toy_outlined,
                    color: Palette.agent,
                  ),
                  onTap: () => _push(
                    context,
                    _ProjectAgentSettings(controller: c, project: project),
                  ),
                ),
                AppTile(
                  title: 'Repository',
                  subtitle: 'Repository, Base Branch and protection',
                  leading: const IconBadge(
                    Icons.code_rounded,
                    color: Palette.info,
                  ),
                  onTap: () => _push(
                    context,
                    _RepositorySettings(controller: c, project: project),
                  ),
                ),
              ],
            ),
            Section(
              title: 'Archive',
              description: archived
                  ? 'This Project is archived and hidden from the Projects list.'
                  : 'Archiving hides the Project from the Projects list. It can be restored.',
              children: [
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    AppButton(
                      label: archived ? 'Unarchive' : 'Archive',
                      icon: archived
                          ? Icons.unarchive_outlined
                          : Icons.archive_outlined,
                      tone: archived ? Tone.secondary : Tone.danger,
                      onPressed: () => _run(
                        context,
                        () => change(
                          'POST',
                          '/projects/${project.id}/${archived ? 'unarchive' : 'archive'}',
                        ),
                      ),
                    ),
                    if (archived && (c.user?.isAdmin ?? false)) ...[
                      AppButton(
                        label: 'Delete permanently',
                        tone: Tone.danger,
                        onPressed: () async {
                          if (!await confirm(
                            context,
                            title: 'Delete ${project.key} permanently?',
                            message:
                                'All its tasks, comments and attachments are deleted. This cannot be undone.',
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
              ],
            ),
          ]),
        );
      },
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
    return _RemotePage<
      (List<Json>, List<Json>, List<Json>, List<Json>, List<Json>)
    >(
      title: 'Agents',
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
          _Choice(
            'permissionMode',
            'Permission mode',
            [for (final m in _permissionModes) (m, m)],
            (a?['permissionMode'] as String?) ?? 'bypassPermissions',
          ),
          _Text(
            'systemPrompt',
            'System prompt',
            initial: (a?['systemPrompt'] as String?) ?? '',
            lines: 5,
          ),
          _Text(
            'env',
            'Environment variables',
            initial: formatAgentEnv(
              (a?['env'] as Json?) ?? const <String, dynamic>{},
            ),
            lines: 5,
            hint:
                'One NAME=value per line. Applied to every Job; wins over '
                'Project variables. Stored in plain text.',
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
          'env': parseAgentEnvText(v['env'] as String),
          'enabled': v['enabled'],
          for (final key in ['skillIds', 'mcpServerIds', 'pluginIds'])
            if (previous == null ||
                !_sameSelection(
                  v[key] as List<String>,
                  List<String>.from(previous[key] as List? ?? const []),
                ))
              key: v[key],
        };
        return (
          actions: [
            if (admin)
              IconAction(
                icon: Icons.add_rounded,
                tooltip: 'New agent',
                filled: true,
                size: 36,
                onPressed: credentials.isEmpty
                    ? () => toast(context, 'Create a Credential first')
                    : () => _form(
                        context,
                        title: 'New agent',
                        subtitle:
                            'Starts from the default Dockerfile; edit it in the web app',
                        fields: fields(null),
                        submit: 'Create agent',
                        onSubmit: (v) => change('POST', '/agents', {
                          ...body(v),
                          'dockerfile':
                              'FROM claude-task/agent-base\nUSER agent\n',
                        }),
                      ),
              ),
          ],
          body: _list([
            if (agents.isEmpty) const EmptyHint('No Agents yet.'),
            for (final a in agents) ...[
              _AgentExtensionStatus(controller: c, agent: a),
              AppTile(
                leading: UserAvatar(
                  label: a['name'] as String,
                  userId: a['id'] as String,
                  imageUrl: a['avatarImageUrl'] as String?,
                  emoji: a['avatarEmoji'] as String? ?? '🤖',
                  api: c.api,
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
                        header: ListenableBuilder(
                          listenable: c,
                          builder: (context, _) => ImageUpload(
                            title: 'Agent image',
                            uploadLabel: 'Upload image',
                            replaceLabel: 'Replace image',
                            removeLabel: 'Remove image',
                            imageUrl: a['avatarImageUrl'] as String?,
                            enabled: c.online,
                            preview: (url) => UserAvatar(
                              label: a['name'] as String,
                              userId: a['id'] as String,
                              imageUrl: url,
                              emoji: a['avatarEmoji'] as String? ?? '🤖',
                              api: c.api,
                              size: 72,
                            ),
                            onChange: (file) async {
                              final result = await c.settingsRequest(
                                file == null ? 'DELETE' : 'PUT',
                                '/agents/${a['id']}/avatar',
                                files: file == null ? const [] : [file],
                              );
                              unawaited(reload().catchError((Object _) {}));
                              unawaited(c.refresh().catchError((Object _) {}));
                              return (result['agent'] as Json)['avatarImageUrl']
                                  as String?;
                            },
                          ),
                        ),
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
                          AppButton(
                            label: 'Delete agent',
                            tone: Tone.danger,
                            onPressed: () async {
                              if (!await confirm(
                                sheet,
                                title: 'Delete ${a['name']}?',
                                message: 'Its container and image are removed.',
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
    return _RemotePage<List<Json>>(
      title: 'Users',
      load: () async =>
          objects((await c.settingsRequest('GET', '/users'))['users']),
      builder: (context, users, reload) {
        Future<Json> change(String method, String path, Json? body) async {
          final result = await c.settingsRequest(method, path, body: body);
          await reload();
          unawaited(c.refresh().catchError((Object _) {}));
          return result;
        }

        return (
          actions: [
            IconAction(
              icon: Icons.person_add_alt_1_outlined,
              tooltip: 'New user',
              filled: true,
              size: 36,
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
          ],
          body: _list([
            for (final u in users)
              AppTile(
                leading: UserAvatar(
                  label: u['displayName'] as String? ?? '',
                  userId: u['id'] as String,
                  imageUrl: u['avatarImageUrl'] as String?,
                  api: c.api,
                ),
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
                          message:
                              'Signs the User out everywhere and generates a temporary password.',
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
      ('anthropic_auth_token', 'Auth token'),
    ];
    String kindLabel(String? k) =>
        kinds.where((e) => e.$1 == k).firstOrNull?.$2 ?? '$k';
    return _RemotePage<List<Json>>(
      title: 'Credentials',
      load: () async => objects(
        (await c.settingsRequest('GET', '/credentials'))['credentials'],
      ),
      builder: (context, credentials, reload) {
        Future<void> change(String method, String path, [Json? body]) async {
          await c.settingsRequest(method, path, body: body);
          await reload();
          unawaited(c.refresh().catchError((Object _) {}));
        }

        return (
          actions: [
            IconAction(
              icon: Icons.add_rounded,
              tooltip: 'New credential',
              filled: true,
              size: 36,
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
          ],
          body: _list([
            const Text(
              'Secrets are write-only; only the last 4 characters show.',
              style: TextStyle(fontSize: 12.5, color: Palette.fgSubtle),
            ),
            const SizedBox(height: 12),
            if (credentials.isEmpty) const EmptyHint('No Credentials yet.'),
            for (final k in credentials)
              AppTile(
                leading: const IconBadge(
                  Icons.key_outlined,
                  color: Palette.warning,
                ),
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
                          message: objects(k['usedBy']).isEmpty
                              ? null
                              : 'It is still used by Agents; the server may refuse.',
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
