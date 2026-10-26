import 'package:material_ui/material_ui.dart';
import 'src/app.dart';
import 'src/controller.dart';
import 'src/push.dart';
import 'src/storage.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final controller = TaskController(
    storage: NativeStorage(),
    push: FirebasePhonePush(),
  );
  runApp(TaskApp(controller: controller));
  controller.initialize();
}
