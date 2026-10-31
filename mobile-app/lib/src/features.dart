// Build-time feature flags, set with `--dart-define=NAME=true`.

/// Voice Rooms: their controls and Join action. Off unless the build enables
/// it with `--dart-define=VOICE_ROOMS=true`.
const voiceRoomsEnabled = bool.fromEnvironment('VOICE_ROOMS');
