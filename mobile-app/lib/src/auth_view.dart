import 'package:flutter/material.dart';
import 'app.dart';
import 'controller.dart';
import 'ui/theme.dart';
import 'ui/widgets.dart';

class AuthView extends StatefulWidget {
  final TaskController controller;
  final bool changePassword;
  const AuthView({
    super.key,
    required this.controller,
    this.changePassword = false,
  });
  @override
  State<AuthView> createState() => _AuthViewState();
}

class _AuthViewState extends State<AuthView> {
  final _form = GlobalKey<FormState>();
  final _url = TextEditingController(
    text: const String.fromEnvironment('BACKEND_URL'),
  );
  final _email = TextEditingController(),
      _password = TextEditingController(),
      _newPassword = TextEditingController();
  bool _changing = false, _reveal = false;
  @override
  void dispose() {
    _url.dispose();
    _email.dispose();
    _password.dispose();
    _newPassword.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    if (widget.changePassword) {
      setState(() => _changing = true);
      await perform(
        context,
        () =>
            widget.controller.changePassword(_password.text, _newPassword.text),
      );
      if (mounted) setState(() => _changing = false);
    } else {
      await widget.controller.login(
        _url.text,
        _email.text.trim(),
        _password.text,
      );
    }
    _password.clear();
    _newPassword.clear();
  }

  @override
  Widget build(BuildContext context) {
    final change = widget.changePassword;
    final busy = widget.controller.busy || _changing;
    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: RadialGradient(
          center: const Alignment(-.4, -1.15),
          radius: 1.2,
          colors: [
            Palette.primary.withValues(alpha: .2),
            Palette.primary.withValues(alpha: .04),
            Palette.bg,
          ],
          stops: const [0, .45, 1],
        ),
      ),
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 400),
            child: Form(
              key: _form,
              child: AutofillGroup(
                child: FadeSlideIn(
                  offset: Offset.zero,
                  scale: .97,
                  duration: Motion.slow,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      const Align(
                        alignment: Alignment.centerLeft,
                        child: FadeSlideIn(
                          scale: .6,
                          offset: Offset.zero,
                          duration: Motion.slow,
                          child: BrandMark(size: 52),
                        ),
                      ),
                      const SizedBox(height: 28),
                      Text.rich(
                        change
                            ? const TextSpan(text: 'Choose a new password')
                            : const TextSpan(
                                children: [
                                  TextSpan(text: 'Your team.\n'),
                                  TextSpan(
                                    text: 'Your Agents.',
                                    style: TextStyle(
                                      color: Palette.primarySoft,
                                    ),
                                  ),
                                ],
                              ),
                        style: Theme.of(context).textTheme.displaySmall,
                      ),
                      const SizedBox(height: 10),
                      Text(
                        change
                            ? 'Change your temporary password to continue.'
                            : 'Sign in to your Claude Task installation.',
                        style: const TextStyle(
                          color: Palette.fgMuted,
                          fontSize: 15,
                        ),
                      ),
                      const SizedBox(height: 32),
                      if (!change) ...[
                        const FieldLabel('Installation URL'),
                        TextFormField(
                          key: const Key('installation-url'),
                          controller: _url,
                          keyboardType: TextInputType.url,
                          autocorrect: false,
                          textInputAction: TextInputAction.next,
                          decoration: const InputDecoration(
                            hintText: 'https://tasks.example.com',
                            prefixIcon: Icon(Icons.dns_outlined, size: 19),
                          ),
                          validator: _required,
                        ),
                        const SizedBox(height: 18),
                        const FieldLabel('Email'),
                        TextFormField(
                          key: const Key('email'),
                          controller: _email,
                          keyboardType: TextInputType.emailAddress,
                          autocorrect: false,
                          textInputAction: TextInputAction.next,
                          autofillHints: const [AutofillHints.username],
                          decoration: const InputDecoration(
                            hintText: 'you@company.com',
                            prefixIcon: Icon(
                              Icons.alternate_email_rounded,
                              size: 19,
                            ),
                          ),
                          validator: _required,
                        ),
                        const SizedBox(height: 18),
                      ],
                      FieldLabel(change ? 'Current password' : 'Password'),
                      TextFormField(
                        key: const Key('password'),
                        controller: _password,
                        obscureText: !_reveal,
                        autofillHints: const [AutofillHints.password],
                        textInputAction: change
                            ? TextInputAction.next
                            : TextInputAction.go,
                        decoration: InputDecoration(
                          hintText: '••••••••',
                          prefixIcon: const Icon(
                            Icons.lock_outline_rounded,
                            size: 19,
                          ),
                          suffixIcon: IconButton(
                            tooltip: _reveal
                                ? 'Hide password'
                                : 'Show password',
                            onPressed: () => setState(() => _reveal = !_reveal),
                            icon: Icon(
                              _reveal
                                  ? Icons.visibility_off_outlined
                                  : Icons.visibility_outlined,
                              size: 19,
                            ),
                          ),
                        ),
                        validator: _required,
                        onFieldSubmitted: change ? null : (_) => _submit(),
                      ),
                      if (change) ...[
                        const SizedBox(height: 18),
                        const FieldLabel(
                          'New password',
                          hint: 'min. 8 characters',
                        ),
                        TextFormField(
                          key: const Key('new-password'),
                          controller: _newPassword,
                          obscureText: !_reveal,
                          autofillHints: const [AutofillHints.newPassword],
                          decoration: const InputDecoration(
                            hintText: '••••••••',
                            prefixIcon: Icon(Icons.key_rounded, size: 19),
                          ),
                          validator: (v) => v != null && v.length >= 8
                              ? null
                              : 'At least 8 characters',
                          onFieldSubmitted: (_) => _submit(),
                        ),
                      ],
                      const SizedBox(height: 28),
                      AppButton(
                        label: change ? 'Change password' : 'Sign in',
                        icon: change ? null : Icons.arrow_forward_rounded,
                        busy: busy,
                        expand: true,
                        onPressed: _submit,
                      ),
                      if (change) ...[
                        const SizedBox(height: 10),
                        AppButton(
                          label: 'Log out',
                          tone: Tone.ghost,
                          expand: true,
                          onPressed: () =>
                              perform(context, widget.controller.logout),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  String? _required(String? value) =>
      value == null || value.trim().isEmpty ? 'Required' : null;
}
