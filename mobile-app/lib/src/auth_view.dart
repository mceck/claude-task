import 'package:flutter/material.dart';
import 'app.dart';
import 'controller.dart';

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
  bool _changing = false;
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
  Widget build(BuildContext context) => Center(
    child: SingleChildScrollView(
      padding: const EdgeInsets.all(28),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Form(
          key: _form,
          child: AutofillGroup(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Icon(
                  Icons.forum_rounded,
                  size: 48,
                  color: Color(0xffb5a9ff),
                ),
                const SizedBox(height: 24),
                Text(
                  widget.changePassword
                      ? 'Choose a new password'
                      : 'Your team. Your Agents.',
                  style: Theme.of(context).textTheme.headlineMedium,
                ),
                const SizedBox(height: 8),
                Text(
                  widget.changePassword
                      ? 'Change your temporary password to continue.'
                      : 'Sign in to your Claude Task installation.',
                ),
                const SizedBox(height: 28),
                if (!widget.changePassword) ...[
                  TextFormField(
                    key: const Key('installation-url'),
                    controller: _url,
                    keyboardType: TextInputType.url,
                    autocorrect: false,
                    decoration: const InputDecoration(
                      labelText: 'Installation URL',
                      hintText: 'https://tasks.example.com',
                    ),
                    validator: _required,
                  ),
                  const SizedBox(height: 16),
                  TextFormField(
                    key: const Key('email'),
                    controller: _email,
                    keyboardType: TextInputType.emailAddress,
                    autofillHints: const [AutofillHints.username],
                    decoration: const InputDecoration(labelText: 'Email'),
                    validator: _required,
                  ),
                  const SizedBox(height: 16),
                ],
                TextFormField(
                  key: const Key('password'),
                  controller: _password,
                  obscureText: true,
                  autofillHints: const [AutofillHints.password],
                  decoration: InputDecoration(
                    labelText: widget.changePassword
                        ? 'Current password'
                        : 'Password',
                  ),
                  validator: _required,
                  onFieldSubmitted: (_) => _submit(),
                ),
                if (widget.changePassword) ...[
                  const SizedBox(height: 16),
                  TextFormField(
                    key: const Key('new-password'),
                    controller: _newPassword,
                    obscureText: true,
                    decoration: const InputDecoration(
                      labelText: 'New password',
                    ),
                    validator: (v) => v != null && v.length >= 8
                        ? null
                        : 'At least 8 characters',
                  ),
                ],
                const SizedBox(height: 24),
                FilledButton(
                  onPressed: widget.controller.busy || _changing
                      ? null
                      : _submit,
                  child: Text(
                    widget.changePassword ? 'Change password' : 'Sign in',
                  ),
                ),
                if (widget.changePassword)
                  TextButton(
                    onPressed: () => perform(context, widget.controller.logout),
                    child: const Text('Log out'),
                  ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
  String? _required(String? value) =>
      value == null || value.trim().isEmpty ? 'Required' : null;
}
