import 'dart:async';

import 'package:flutter/foundation.dart';

import 'models.dart';
import 'storage.dart';

/// Which kinds of Timeline entry the reader hides. One viewer preference,
/// shared by every Task of every Project.
@immutable
class TimelineVisibility {
  const TimelineVisibility({this.changes = true, this.activity = false});

  static const defaults = TimelineVisibility();

  /// Revisions: the recorded field changes of the Task.
  final bool changes;

  /// The Agent's items: Thinking, Activity and tool calls, Runs, Turn Summaries
  /// and notices.
  final bool activity;

  bool get anythingHidden => changes || activity;

  /// The choice in words, for the trigger: "Changes hidden", "Everything shown".
  String get label {
    final kinds = [if (changes) 'Changes', if (activity) 'Activity'];
    return kinds.isEmpty ? 'Everything shown' : '${kinds.join(' + ')} hidden';
  }

  TimelineVisibility copyWith({bool? changes, bool? activity}) =>
      TimelineVisibility(
        changes: changes ?? this.changes,
        activity: activity ?? this.activity,
      );

  Json toJson() => {'changes': changes, 'activity': activity};

  factory TimelineVisibility.fromJson(Json json) => TimelineVisibility(
    changes: json['changes'] is bool
        ? json['changes'] as bool
        : defaults.changes,
    activity: json['activity'] is bool
        ? json['activity'] as bool
        : defaults.activity,
  );

  @override
  bool operator ==(Object other) =>
      other is TimelineVisibility &&
      other.changes == changes &&
      other.activity == activity;

  @override
  int get hashCode => Object.hash(changes, activity);
}

/// The viewer's Timeline preference, saved with the profile so every Task
/// follows it.
class TimelineVisibilityStore extends ValueNotifier<TimelineVisibility> {
  TimelineVisibilityStore(this._storage) : super(_read(_storage));

  final ProfileStorage _storage;
  static const _key = 'timeline-hidden';

  static TimelineVisibility _read(ProfileStorage storage) {
    final raw = storage.read(_key);
    return raw == null
        ? TimelineVisibility.defaults
        : TimelineVisibility.fromJson(raw);
  }

  /// Reads the open profile's choice again, after a Login switch.
  void reload() => value = _read(_storage);

  void set({bool? changes, bool? activity}) {
    final next = value.copyWith(changes: changes, activity: activity);
    if (next == value) return;
    value = next;
    unawaited(_storage.write(_key, next.toJson()));
  }

  void showEverything() => set(changes: false, activity: false);
}
