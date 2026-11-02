import 'package:material_ui/material_ui.dart';

import 'controller.dart';
import 'models.dart';
import 'task_forms.dart' show workerStateDot;
import 'ui/widgets.dart';

/// What the Workers list and pickers say about a Worker's state.
String workerStateLabel(String state) => switch (state) {
  'build_failed' => 'build failed',
  '' => 'unknown',
  _ => state,
};

/// One line about a Worker: its state, its busy and running Worker
/// Containers against its cap, and its Queue.
String workerSummary(Worker w) =>
    '${workerStateLabel(w.state)} · ${w.busy} busy · '
    '${w.running}/${w.cap} running · queue ${w.queueLength}';

/// The Worker a new Project, Wiki or Schedule starts with: the only one.
String? soleWorkerId(List<Worker> workers) =>
    workers.length == 1 ? workers.single.id : null;

/// Opens the Worker picker: every Worker with its state dot.
Future<String?> pickWorker(
  BuildContext context,
  List<Worker> workers,
  String? selected,
) => showPicker<String>(
  context,
  title: 'Worker',
  selected: selected ?? '',
  options: [
    for (final w in workers)
      PickerOption(
        w.id,
        w.name,
        detail: workerSummary(w),
        trailing: workerStateDot(w),
      ),
  ],
);

/// The Worker select field of the Project, Wiki and Schedule forms. Without
/// any Worker it explains who can create one, and stays disabled.
class WorkerField extends StatelessWidget {
  final TaskController controller;
  final String? workerId;

  /// Null disables the field.
  final ValueChanged<String>? onChanged;
  final String? description;
  const WorkerField({
    super.key,
    required this.controller,
    required this.workerId,
    required this.onChanged,
    this.description,
  });

  /// Why nothing can be picked, for the User's role.
  static String noWorkers(TaskController c) => c.user?.isAdmin == true
      ? "Create a Worker first, in the web app's Workers section."
      : 'Ask an Admin to create a Worker.';

  @override
  Widget build(BuildContext context) {
    final workers = controller.workers, worker = workers.byId(workerId);
    final change = onChanged;
    return LabeledField(
      label: 'Worker',
      description: workers.isEmpty ? noWorkers(controller) : description,
      child: SelectField(
        key: const Key('worker-field'),
        leading: worker == null ? null : workerStateDot(worker),
        label:
            worker?.name ??
            (workers.isEmpty ? 'No Workers' : 'Choose a Worker'),
        placeholder: worker == null,
        onTap: workers.isEmpty || change == null
            ? null
            : () async {
                final selected = await pickWorker(context, workers, workerId);
                if (selected != null && selected.isNotEmpty) change(selected);
              },
      ),
    );
  }
}
