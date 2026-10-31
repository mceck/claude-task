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

  /// Sessions running and open Tasks unread by this User, from the Projects list.
  final int runningAgents, unreadTasks;
  Project.fromJson(Json json)
    : id = json['id'] as String,
      key = json['key'] as String,
      name = json['name'] as String,
      description = json['description'] as String? ?? '',
      logoUrl = json['logoUrl'] as String?,
      taskCounts = {
        for (final e in (json['taskCounts'] as Map? ?? {}).entries)
          e.key as String: (e.value as num).toInt(),
      },
      runningAgents =
          ((json['activity'] as Map?)?['runningAgents'] as num? ?? 0).toInt(),
      unreadTasks = ((json['activity'] as Map?)?['unreadTasks'] as num? ?? 0)
          .toInt();
  int get taskTotal => taskCounts.values.fold(0, (a, b) => a + b);

  /// Tasks outside the closed Category, which Project progress leaves out.
  int get progressTaskTotal => taskTotal - (taskCounts['closed'] ?? 0);
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
  final bool extensionsPending;
  final String? extensionsError;
  final List<SkillCommand> skillCommands;
  Agent.fromJson(Json json)
    : id = json['id'] as String,
      name = json['name'] as String,
      emoji = json['avatarEmoji'] as String? ?? '🤖',
      avatarImageUrl = json['avatarImageUrl'] as String?,
      enabled = json['enabled'] == true,
      extensionsPending = json['extensionsPending'] == true,
      extensionsError = json['extensionsError'] as String?,
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

/// One of a Wiki's conversations. Its id is the id of the Task that holds it.
class WikiChat implements Identified {
  @override
  final String id;
  final String wikiId, title;
  final String? agentId, sessionState;
  final bool running, unread;
  final DateTime createdAt, lastActivityAt;
  WikiChat.fromJson(Json json)
    : id = json['id'] as String,
      wikiId = json['wikiId'] as String? ?? '',
      title = json['title'] as String? ?? 'Chat',
      agentId = json['agentId'] as String?,
      sessionState = json['sessionState'] as String?,
      running = json['running'] == true,
      unread = json['unread'] == true,
      createdAt =
          DateTime.tryParse(json['createdAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
      lastActivityAt =
          DateTime.tryParse(json['lastActivityAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0);
}

class Task {
  final String id, projectId, key, title, description, statusId, priority;
  final String? agentId, branchName, branchUrl, pullRequestUrl;

  /// The Pull Request as the API sends it (provider, number, url, state, draft).
  final Json? pullRequest;

  /// The Agent Session as the board card shows it.
  final String? sessionState;
  final int? queuePosition;
  final List<String> tagIds, assigneeIds;
  final int version, commentCount, chatGeneration;

  /// Whether a usage limit with a known reset time resumes the Task without asking.
  final bool autoResume;
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
      autoResume = json['autoResume'] == true,
      version = json['version'] as int? ?? 1,
      commentCount = (json['commentCount'] as num?)?.toInt() ?? 0,
      sessionState = (json['session'] as Map?)?['state'] as String?,
      queuePosition = ((json['session'] as Map?)?['queuePosition'] as num?)
          ?.toInt(),
      branchName = json['branchName'] as String?,
      branchUrl = json['branchUrl'] as String?,
      pullRequest = json['pullRequest'] == null
          ? null
          : Json.from(json['pullRequest'] as Map),
      pullRequestUrl = (json['pullRequest'] as Map?)?['url'] as String?;

  /// Merging works on open Pull Requests that aren't drafts.
  bool get canMergePullRequest =>
      pullRequest?['state'] == 'open' && pullRequest?['draft'] != true;

  /// GitLab calls it a merge request.
  String get pullRequestNoun =>
      pullRequest?['provider'] == 'gitlab' ? 'Merge Request' : 'Pull Request';
}

class TaskPreference {
  final String taskId, readPosition, latestPosition;
  final bool following, muted, unread;
  final int unreadComments;
  TaskPreference.fromJson(Json json)
    : taskId = json['taskId'] as String,
      following = json['following'] == true,
      muted = json['muted'] == true,
      unread = json['unread'] == true,
      unreadComments = (json['unreadComments'] as num?)?.toInt() ?? 0,
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

  /// The structured part of an Agent's Question, shown as a card.
  Question? get question => content['question'] is Map
      ? Question.fromJson(Json.from(content['question'] as Map))
      : null;

  /// The structured part of an Agent's Survey, shown as a card.
  Survey? get survey => content['survey'] is Map
      ? Survey.fromJson(Json.from(content['survey'] as Map))
      : null;

  /// On the User Comment that answers a Question: the Question's Comment id.
  String? get answersCommentId => content['answersCommentId'] as String?;

  /// On the System Comment of a usage limit: the offer to resume at the reset.
  LimitResume? get limitResume => content['limitResume'] is Map
      ? LimitResume.fromJson(Json.from(content['limitResume'] as Map))
      : null;
}

/// The offer to resume a Task once its usage limit resets.
class LimitResume {
  final DateTime resetsAt;
  final DateTime? decidedAt;

  /// `open`, `scheduled`, `declined` or `unneeded`.
  final String state;

  /// Null while open, when automatic resume decided and when it became unneeded.
  final Actor? decidedBy;
  LimitResume.fromJson(Json json)
    : resetsAt =
          DateTime.tryParse(json['resetsAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
      decidedAt = DateTime.tryParse(json['decidedAt'] as String? ?? ''),
      state = json['state'] as String? ?? 'open',
      decidedBy = Actor.maybe(json['decidedBy']);
  bool get open => state == 'open';
}

/// A Comment written ahead of time, published when it is due.
class ScheduledMessage implements Identified {
  @override
  final String id;
  final String taskId, kind, body, state;
  final String? cancelReason;
  final Actor author;
  final bool internal;
  final List<Json> attachments;
  final DateTime dueAt;

  /// As the API sent it, for the offline cache.
  final Json json;
  ScheduledMessage.fromJson(this.json)
    : id = json['id'] as String,
      taskId = json['taskId'] as String? ?? '',
      kind = json['kind'] as String? ?? 'user',
      body = json['body'] as String? ?? '',
      state = json['state'] as String? ?? 'pending',
      cancelReason = json['cancelReason'] as String?,
      author = Actor.fromJson(Json.from(json['author'] as Map? ?? {})),
      internal = json['internal'] == true,
      attachments = objects(json['attachments']),
      dueAt =
          DateTime.tryParse(json['dueAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0);
  bool get pending => state == 'pending';
  bool get isLimitResume => kind == 'limit_resume';
}

/// A configured recurring job: an Agent, a cron expression, a time zone and a
/// prompt. Its runs are Tasks of its hidden Schedule Project.
class Schedule implements Identified {
  @override
  final String id;
  final String projectId, name, cron, timeZone, prompt;
  final String? agentId;

  /// Null for a global Schedule: its Agent works on the boards.
  final Json? repository;
  final bool readOnly, enabled;
  final DateTime? nextRunAt;
  final int consecutiveSkips;
  final Actor? createdBy;
  final ScheduleRun? lastRun;
  final DateTime createdAt, updatedAt;

  /// As the API sent it, for the offline cache.
  final Json json;
  Schedule.fromJson(this.json)
    : id = json['id'] as String,
      projectId = json['projectId'] as String? ?? '',
      name = json['name'] as String? ?? '',
      agentId = json['agentId'] as String?,
      cron = json['cron'] as String? ?? '',
      timeZone = json['timeZone'] as String? ?? 'UTC',
      prompt = json['prompt'] as String? ?? '',
      repository = json['repository'] == null
          ? null
          : Json.from(json['repository'] as Map),
      readOnly = json['readOnly'] == true,
      enabled = json['enabled'] != false,
      nextRunAt = DateTime.tryParse(json['nextRunAt'] as String? ?? ''),
      consecutiveSkips = (json['consecutiveSkips'] as num?)?.toInt() ?? 0,
      createdBy = Actor.maybe(json['createdBy']),
      lastRun = json['lastRun'] is Map
          ? ScheduleRun.fromJson(Json.from(json['lastRun'] as Map))
          : null,
      createdAt =
          DateTime.tryParse(json['createdAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
      updatedAt =
          DateTime.tryParse(json['updatedAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0);
  bool get global => repository == null;
  String get repositoryName =>
      global ? 'Global' : '${repository!['owner']}/${repository!['name']}';
}

/// One execution of a [Schedule]: a Task of its Schedule Project, or a due
/// time that was skipped and has no Task.
class ScheduleRun implements Identified {
  @override
  final String id;
  final String scheduleId;

  /// `running`, `succeeded`, `failed` or `skipped`.
  final String state;
  final bool manual;
  final DateTime dueAt, startedAt;
  final DateTime? finishedAt;

  /// Null for a skipped run.
  final String? taskId, taskKey;
  final String? skipReason;

  /// As the API sent it, for the offline cache.
  final Json json;
  ScheduleRun.fromJson(this.json)
    : id = json['id'] as String,
      scheduleId = json['scheduleId'] as String? ?? '',
      state = json['state'] as String? ?? 'running',
      manual = json['manual'] == true,
      dueAt =
          DateTime.tryParse(json['dueAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
      startedAt =
          DateTime.tryParse(json['startedAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
      finishedAt = DateTime.tryParse(json['finishedAt'] as String? ?? ''),
      taskId = json['taskId'] as String?,
      taskKey = json['taskKey'] as String?,
      skipReason = json['skipReason'] as String?;
  bool get skipped => state == 'skipped';
  bool get running => state == 'running';
  Duration? get duration => finishedAt?.difference(startedAt);
}

/// Whoever performed an action; [id] is null for the system.
class Actor {
  final String? id;
  final String displayName;
  Actor.fromJson(Json json)
    : id = json['id'] as String?,
      displayName = json['displayName'] as String? ?? 'Someone';
  static Actor? maybe(Object? json) =>
      json is Map ? Actor.fromJson(Json.from(json)) : null;
}

/// One option of a [QuestionItem].
class QuestionOption {
  final String label, description;
  QuestionOption.fromJson(Json json)
    : label = json['label'] as String,
      description = json['description'] as String? ?? '';
}

/// One multiple-choice item of a Question or Survey; the clients add "Other".
class QuestionItem {
  final String header, question;
  final List<QuestionOption> options;
  final bool multiSelect;
  QuestionItem.fromJson(Json json)
    : header = json['header'] as String? ?? '',
      question = json['question'] as String? ?? '',
      options = objects(json['options']).map(QuestionOption.fromJson).toList(),
      multiSelect = json['multiSelect'] == true;
  static List<QuestionItem> list(Object? json) =>
      objects(json).map(QuestionItem.fromJson).toList();
}

/// The answer to one item: the chosen option labels and the "Other" text.
class QuestionAnswer {
  final List<String> selected;
  final String? other;
  const QuestionAnswer(this.selected, [this.other]);
  QuestionAnswer.fromJson(Json json)
    : selected = strings(json['selected']),
      other = json['other'] as String?;
  static List<QuestionAnswer> list(Object? json) =>
      objects(json).map(QuestionAnswer.fromJson).toList();
  Json toJson() => {'selected': selected, 'other': other};
}

class Question {
  final List<QuestionItem> items;
  final List<QuestionAnswer>? answer;
  final Actor? answeredBy;
  final DateTime? answeredAt;
  final bool open;
  Question.fromJson(Json json)
    : items = QuestionItem.list(json['items']),
      open = json['state'] == 'open',
      answer = json['answer'] == null
          ? null
          : QuestionAnswer.list(json['answer']),
      answeredBy = Actor.maybe(json['answeredBy']),
      answeredAt = DateTime.tryParse(json['answeredAt'] as String? ?? '');
}

class SurveyResponse {
  final Actor user;
  final List<QuestionAnswer> answers;
  final String updatedAt;
  SurveyResponse.fromJson(Json json)
    : user = Actor.fromJson(Json.from(json['user'] as Map)),
      answers = QuestionAnswer.list(json['answers']),
      updatedAt = json['updatedAt'] as String? ?? '';
}

class Survey {
  final List<QuestionItem> items;
  final bool open;

  /// The Task's Assignees when the Survey was created.
  final List<Actor> expectedRespondents;

  /// In first-answer order.
  final List<SurveyResponse> responses;

  /// Null while open, and when it closed because everyone expected answered.
  final Actor? closedBy;
  final DateTime? closedAt;
  Survey.fromJson(Json json)
    : items = QuestionItem.list(json['items']),
      open = json['state'] == 'open',
      expectedRespondents = objects(json['expectedRespondents'])
          .map(Actor.fromJson)
          .toList(),
      responses = objects(json['responses'])
          .map(SurveyResponse.fromJson)
          .toList(),
      closedBy = Actor.maybe(json['closedBy']),
      closedAt = DateTime.tryParse(json['closedAt'] as String? ?? '');

  SurveyResponse? responseOf(String? userId) =>
      responses.where((r) => r.user.id == userId).firstOrNull;
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
