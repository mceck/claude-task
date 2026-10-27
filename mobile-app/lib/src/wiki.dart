import 'package:material_ui/material_ui.dart';

import 'app.dart';
import 'controller.dart';
import 'models.dart';
import 'task_forms.dart';
import 'ui/theme.dart';
import 'ui/widgets.dart';

class WikiList extends StatelessWidget {
  final TaskController controller;
  const WikiList({super.key, required this.controller});
  @override
  Widget build(BuildContext context) {
    final c = controller;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 18),
          child: Row(
            children: [
              const DrawerBrandMark(),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Wiki',
                      style: TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.w600,
                        letterSpacing: -.6,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      '${c.wikis.length} ${c.wikis.length == 1 ? 'wiki' : 'wikis'}',
                      style: const TextStyle(
                        fontSize: 12,
                        color: Palette.fgSubtle,
                      ),
                    ),
                  ],
                ),
              ),
              IconAction(
                icon: Icons.add_rounded,
                tooltip: 'New wiki',
                onPressed: c.online ? () => showWikiForm(context, c) : null,
              ),
            ],
          ),
        ),
        const Divider(),
        Expanded(
          child: RefreshIndicator(
            onRefresh: c.refresh,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.all(12),
              children: [
                if (c.wikis.isEmpty)
                  const Padding(
                    padding: EdgeInsets.all(24),
                    child: Text(
                      'Create a wiki to work together on your Markdown documentation.',
                      style: TextStyle(color: Palette.fgSubtle),
                    ),
                  ),
                for (final wiki in c.wikis)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Pressable(
                      onTap: () => perform(context, () => c.selectWiki(wiki)),
                      padding: const EdgeInsets.all(14),
                      color: c.wiki?.id == wiki.id
                          ? Palette.muted
                          : Palette.surface,
                      border: Border.all(color: Palette.border),
                      child: Row(
                        children: [
                          const Icon(
                            Icons.menu_book_outlined,
                            size: 22,
                            color: Palette.primary,
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  wiki.name,
                                  style: const TextStyle(
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  wiki.repositoryName,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                    fontSize: 12,
                                    color: Palette.fgSubtle,
                                  ),
                                ),
                                if (wiki.description.isNotEmpty)
                                  Text(
                                    wiki.description,
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                      fontSize: 12,
                                      color: Palette.fgMuted,
                                    ),
                                  ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

Future<void> showWikiForm(
  BuildContext context,
  TaskController c, {
  Wiki? wiki,
}) => showAppSheet<void>(
  context,
  maxWidth: 580,
  builder: (_) => _WikiForm(controller: c, wiki: wiki),
);

class _WikiForm extends StatefulWidget {
  final TaskController controller;
  final Wiki? wiki;
  const _WikiForm({required this.controller, this.wiki});
  @override
  State<_WikiForm> createState() => _WikiFormState();
}

class _WikiFormState extends State<_WikiForm> {
  late final name = TextEditingController(text: widget.wiki?.name ?? '');
  late final description = TextEditingController(
    text: widget.wiki?.description ?? '',
  );
  final base = TextEditingController();
  late String? agentId = widget.wiki?.agentId;
  List<Json> repositories = [];
  Json? repository;
  String? error;
  bool loading = true, saving = false;
  @override
  void initState() {
    super.initState();
    if (widget.wiki == null) {
      widget.controller
          .wikiRepositories()
          .then((value) {
            if (mounted) {
              setState(() {
                repositories = value;
                loading = false;
              });
            }
          })
          .catchError((Object e) {
            if (mounted) {
              setState(() {
                error = e.toString();
                loading = false;
              });
            }
          });
    } else {
      loading = false;
    }
  }

  @override
  void dispose() {
    name.dispose();
    description.dispose();
    base.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SheetScaffold(
    title: widget.wiki == null ? 'New wiki' : 'Wiki settings',
    subtitle:
        widget.wiki?.repositoryName ??
        'Markdown files and skills in a shared repository',
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
        const FieldLabel('Name'),
        TextField(
          controller: name,
          maxLength: 200,
          enabled: !saving,
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 12),
        const FieldLabel('Description'),
        TextField(controller: description, maxLines: 3, enabled: !saving),
        const SizedBox(height: 16),
        const FieldLabel('Agent'),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final agent in widget.controller.agents.where(
              (a) => a.enabled || a.id == agentId,
            ))
              ChoiceChipX(
                label: agent.name,
                selected: agent.id == agentId,
                onChanged: saving
                    ? null
                    : (_) => setState(() => agentId = agent.id),
              ),
          ],
        ),
        if (widget.wiki != null) ...[
          const SizedBox(height: 16),
          AppButton(
            label: 'Open repository',
            tone: Tone.secondary,
            onPressed: () =>
                openLink(widget.wiki!.repository['webUrl'] as String?),
          ),
          if (widget.controller.task?.branchUrl != null) ...[
            const SizedBox(height: 8),
            AppButton(
              label: 'Open wiki branch',
              tone: Tone.secondary,
              onPressed: () => openLink(widget.controller.task!.branchUrl),
            ),
          ],
          if (widget.controller.task?.pullRequestUrl != null) ...[
            const SizedBox(height: 8),
            AppButton(
              label: 'Open review',
              tone: Tone.secondary,
              onPressed: () => openLink(widget.controller.task!.pullRequestUrl),
            ),
          ],
        ],
        if (widget.wiki == null) ...[
          const SizedBox(height: 16),
          const FieldLabel('Repository'),
          if (loading)
            const Center(child: Spinner())
          else
            Builder(
              builder: (anchor) => AppButton(
                tone: Tone.secondary,
                label: repository == null
                    ? 'Choose a repository'
                    : '${repository!['owner']}/${repository!['name']}',
                onPressed: saving || repositories.isEmpty
                    ? null
                    : () async {
                        final selected = await showAppSheet<Json>(
                          anchor,
                          maxWidth: 580,
                          builder: (sheet) => SheetScaffold(
                            title: 'Repository',
                            body: Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                for (final r in repositories)
                                  Pressable(
                                    onTap: () => Navigator.pop(sheet, r),
                                    padding: const EdgeInsets.all(14),
                                    child: Align(
                                      alignment: Alignment.centerLeft,
                                      child: Text(
                                        '${r['owner']}/${r['name']}',
                                        maxLines: 2,
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ),
                                  ),
                              ],
                            ),
                          ),
                        );
                        if (selected != null && mounted) {
                          setState(() {
                            repository = selected;
                            base.text =
                                repository!['defaultBranch'] as String? ?? '';
                          });
                        }
                      },
              ),
            ),
          if (!loading && repositories.isEmpty)
            const Text(
              'Add a Git Connection in Git settings on the web to select a repository.',
              style: TextStyle(color: Palette.fgSubtle),
            ),
          const SizedBox(height: 12),
          const FieldLabel('Base branch'),
          TextField(controller: base, enabled: !saving),
        ],
        const SizedBox(height: 24),
        AppButton(
          label: widget.wiki == null ? 'Create wiki' : 'Save wiki',
          busy: saving,
          onPressed:
              saving ||
                  name.text.trim().isEmpty ||
                  agentId == null ||
                  (widget.wiki == null && repository == null)
              ? null
              : () async {
                  setState(() {
                    saving = true;
                    error = null;
                  });
                  try {
                    await widget.controller.saveWiki({
                      'name': name.text.trim(),
                      'description': description.text,
                      'agentId': agentId,
                      if (widget.wiki == null)
                        'repository': {
                          'connectionId': repository!['connectionId'],
                          'providerRepoId': repository!['providerRepoId'],
                          if (base.text.trim().isNotEmpty)
                            'baseBranch': base.text.trim(),
                        },
                    }, existing: widget.wiki);
                    if (context.mounted) Navigator.pop(context);
                  } catch (e) {
                    if (mounted) {
                      setState(() {
                        error = e.toString();
                        saving = false;
                      });
                    }
                  }
                },
        ),
      ],
    ),
  );
}

Future<void> confirmResetWiki(BuildContext context, TaskController c) async {
  if (await confirm(
    context,
    title: 'Reset chat?',
    message: 'Delete all messages for everyone and start a fresh agent session. Wiki files are kept.',
    confirmLabel: 'Reset chat',
  )) {
    if (context.mounted) await perform(context, c.resetWiki);
  }
}

Future<void> confirmDeleteWiki(BuildContext context, TaskController c) async {
  if (await confirm(
    context,
    title: 'Delete wiki?',
    message: 'Delete the wiki and its chat from the app. The remote repository is kept.',
    confirmLabel: 'Delete wiki',
  )) {
    if (context.mounted) await perform(context, c.deleteWiki);
  }
}
