import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';

import 'src/app.dart';
import 'src/controller.dart';
import 'src/push.dart';
import 'src/storage.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
  final controller = TaskController(
    storage: NativeStorage(),
    push: FirebasePhonePush(),
  );
  runApp(TaskApp(controller: controller));
  controller.initialize();
}
