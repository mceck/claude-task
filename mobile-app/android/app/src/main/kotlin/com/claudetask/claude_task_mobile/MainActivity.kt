package com.claudetask.claude_task_mobile

import android.content.Intent
import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val channel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "claude_task/voice")
        VoiceService.channel = channel
        channel.setMethodCallHandler { call, result ->
            when (call.method) {
                "start" -> {
                    try {
                        val intent = Intent(this, VoiceService::class.java)
                            .putExtra("taskKey", call.argument<String>("taskKey"))
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent)
                        else startService(intent)
                        result.success(null)
                    } catch (error: Exception) {
                        result.error("voice_background", "Open the app and allow microphone access before joining voice.", null)
                    }
                }
                "stop" -> { stopService(Intent(this, VoiceService::class.java)); result.success(null) }
                else -> result.notImplemented()
            }
        }
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        VoiceService.channel?.setMethodCallHandler(null)
        VoiceService.channel = null
        stopService(Intent(this, VoiceService::class.java))
        super.cleanUpFlutterEngine(flutterEngine)
    }
}
