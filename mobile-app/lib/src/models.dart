typedef Json = Map<String, dynamic>;

abstract interface class Identified {
  String get id;
}

extension IdLookup<T extends Identified> on Iterable<T> {
  /// The element with this id, or null (also for a null id).
  T? byId(Object? id) => where((x) => x.id == id).firstOrNull;
}

List<Json> objects(dynamic value) => (value as List? ?? [])
    .map((e) => Map<String, dynamic>.from(e as Map))
    .toList();
List<String> strings(dynamic value) => (value as List? ?? []).cast<String>();

class User implements Identified {
  @override
  final String id;
  final String email, displayName, role;
  final String? avatarImageUrl;
  final bool mustChangePassword, active;
  bool get isAdmin => role == 'admin';
  User.fromJson(Json json)
    : id = json['id'] as String,
      email = json['email'] as String? ?? '',
      displayName = json['displayName'] as String? ?? '',
      role = json['role'] as String? ?? 'member',
      active = json['active'] != false,
      avatarImageUrl = json['avatarImageUrl'] as String?,
      mustChangePassword = json['mustChangePassword'] == true;
}

class Project {
  final String id, key, name, description;
  final String? logoUrl;

  /// Task counts per Status category, from the Projects list.
  final Map<String, int> taskCounts;
  Project.fromJson(Json json)
    : id = json['id'] as String,
      key = json['key'] as String,
      name = json['name'] as String,
      description = json['description'] as String? ?? '',
      logoUrl = json['logoUrl'] as String?,
      taskCounts = {
        for (final e in (json['taskCounts'] as Map? ?? {}).entries)
          e.key as String: (e.value as num).toInt(),
      };
  int get taskTotal => taskCounts.values.fold(0, (a, b) => a + b);
}

class TaskStatus implements Identified {
  @override
  final String id;
  final String name, category, color;
  TaskStatus.fromJson(Json json)
    : id = json['id'] as String,
      name = json['name'] as String,
      category = json['category'] as String,
      color = json['color'] as String? ?? '#888888';
}

class Tag implements Identified {
  @override
  final String id;
  final String name;
  final String? color;
  Tag.fromJson(Json json)
    : id = json['id'] as String,
      name = json['name'] as String,
      color = json['color'] as String?;
}

class Agent implements Identified {
  @override
  final String id;
  final String name, emoji;
  final String? avatarImageUrl;
  final bool enabled;
  final List<SkillCommand> skillCommands;
  Agent.fromJson(Json json)
    : id = json['id'] as String,
      name = json['name'] as String,
      emoji = json['avatarEmoji'] as String? ?? '🤖',
      avatarImageUrl = json['avatarImageUrl'] as String?,
      enabled = json['enabled'] == true,
      skillCommands = objects(json['skillCommands'])
          .map(SkillCommand.fromJson)
          .toList();
}

class SkillCommand {
  final String name, description, kind;
  SkillCommand.fromJson(Json json)
    : name = json['name'] as String,
      description = json['description'] as String? ?? '',
      kind = json['kind'] as String? ?? 'skill';
}

class Wiki implements Identified {
  @override
  final String id;
  final String name, description, taskId;
  final String? agentId;
  final Json repository;
  Wiki.fromJson(Json json)
    : id = json['id'] as String,
      name = json['name'] as String,
      description = json['description'] as String? ?? '',
      taskId = json['taskId'] as String,
      agentId = json['agentId'] as String?,
      repository = Map<String, dynamic>.from(json['repository'] as Map);
  String get repositoryName => '${repository['owner']}/${repository['name']}';
}

class Task {
  final String id, projectId, key, title, description, statusId, priority;
  final String? agentId, branchName, branchUrl, pullRequestUrl;

  /// The Agent Session as the board card shows it.
  final String? sessionState;
  final int? queuePosition;
  final List<String> tagIds, assigneeIds;
  final int version, commentCount, chatGeneration;
  Task.fromJson(Json json)
    : id = json['id'] as String,
      projectId = json['projectId'] as String,
      key = json['key'] as String,
      title = json['title'] as String,
      description = json['description'] as String? ?? '',
      statusId = json['statusId'] as String,
      priority = json['priority'] as String? ?? 'none',
      agentId = json['agentId'] as String?,
      tagIds = strings(json['tagIds']),
      assigneeIds = strings(json['assigneeIds']),
      chatGeneration = json['chatGeneration'] as int? ?? 0,
      version = json['version'] as int? ?? 1,
      commentCount = (json['commentCount'] as num?)?.toInt() ?? 0,
      sessionState = (json['session'] as Map?)?['state'] as String?,
      queuePosition = ((json['session'] as Map?)?['queuePosition'] as num?)
          ?.toInt(),
      branchName = json['branchName'] as String?,
      branchUrl = json['branchUrl'] as String?,
      pullRequestUrl = (json['pullRequest'] as Map?)?['url'] as String?;
}

class TaskPreference {
  final String taskId, readPosition, latestPosition;
  final bool following, muted, unread;
  TaskPreference.fromJson(Json json)
    : taskId = json['taskId'] as String,
      following = json['following'] == true,
      muted = json['muted'] == true,
      unread = json['unread'] == true,
      readPosition = json['readPosition'] as String? ?? '0',
      latestPosition = json['latestPosition'] as String? ?? '0';
}

class TimelineEntry {
  final Json json;
  TimelineEntry(this.json);
  String get id => json['id'] as String;
  String get type => json['type'] as String;
  DateTime get createdAt => DateTime.parse(json['createdAt'] as String);
  Json get content =>
      Map<String, dynamic>.from(json[type == 'agent' ? 'item' : type] as Map);
  Json get payload =>
      Map<String, dynamic>.from(content['payload'] as Map? ?? {});
  bool get internal => content['internal'] == true;
  bool get deleted => content['deletedAt'] != null;
  String get body => content['body'] as String? ?? '';
  String get author =>
      (content[type == 'revision' ? 'actor' : 'author'] as Map?)?['displayName']
          as String? ??
      'Agent';
  String? get authorId => (content['author'] as Map?)?['id'] as String?;
  bool get isOwnCommentEditable =>
      type == 'comment' && content['kind'] == 'user' && !deleted;
  List<Json> get attachments => objects(content['attachments']);
}

class DraftFile {
  final String path, name;
  const DraftFile(this.path, this.name);
  Json toJson() => {'path': path, 'name': name};
  DraftFile.fromJson(Json json)
    : path = json['path'] as String,
      name = json['name'] as String;
}

class Draft {
  final String text;
  final bool internal;
  final List<DraftFile> files;

  /// A request may have committed before connectivity was lost. Never retry it automatically.
  final bool ambiguous;
  const Draft({
    this.text = '',
    this.internal = false,
    this.files = const [],
    this.ambiguous = false,
  });
  Draft.fromJson(Json json)
    : text = json['text'] as String? ?? '',
      internal = json['internal'] == true,
      files = objects(json['files']).map(DraftFile.fromJson).toList(),
      ambiguous = json['ambiguous'] == true;
  Json toJson() => {
    'text': text,
    'internal': internal,
    'files': files.map((f) => f.toJson()).toList(),
    'ambiguous': ambiguous,
  };
  Draft copyWith({
    String? text,
    bool? internal,
    List<DraftFile>? files,
    bool? ambiguous,
  }) => Draft(
    text: text ?? this.text,
    internal: internal ?? this.internal,
    files: files ?? this.files,
    ambiguous: ambiguous ?? this.ambiguous,
  );
}
