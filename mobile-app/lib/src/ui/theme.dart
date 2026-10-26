import 'package:flutter/material.dart';

/// Dark tokens mirroring the web frontend (`frontend/src/index.css`).
abstract final class Palette {
  static const bg = Color(0xff0b0c10);
  static const sidebar = Color(0xff08090c);
  static const surface = Color(0xff121418);
  static const raised = Color(0xff17181d);
  static const muted = Color(0xff1d1e23);
  static const hover = Color(0xff22232c);
  static const border = Color(0x14ffffff);
  static const borderStrong = Color(0x24ffffff);
  static const fg = Color(0xfff1f2f4);
  static const fgMuted = Color(0xff9598a2);
  static const fgSubtle = Color(0xff676a75);
  static const primary = Color(0xff7c83f7);
  static const primarySoft = Color(0xffa7b0fd);
  static const violet = Color(0xffa78bfa);
  static const danger = Color(0xffff6467);
  static const warning = Color(0xffedb345);
  static const success = Color(0xff4ac06c);
  static const info = Color(0xff38bdf8);
}

abstract final class Radii {
  static const sm = 8.0, md = 12.0, lg = 16.0, xl = 22.0;
}

const mono = 'GeistMono';

/// Stable hue for a name, so Projects and people keep their color.
Color tint(String seed) {
  var hash = 0;
  for (final unit in seed.codeUnits) {
    hash = (hash * 31 + unit) & 0x7fffffff;
  }
  return HSLColor.fromAHSL(1, (hash % 360).toDouble(), .55, .62).toColor();
}

Color hexColor(String hex, [Color fallback = Palette.fgMuted]) {
  final value = int.tryParse(hex.replaceFirst('#', ''), radix: 16);
  return value == null ? fallback : Color(0xff000000 | value);
}

ThemeData buildTheme() {
  const scheme = ColorScheme.dark(
    primary: Palette.primary,
    onPrimary: Colors.white,
    secondary: Palette.primarySoft,
    onSecondary: Palette.bg,
    surface: Palette.bg,
    onSurface: Palette.fg,
    onSurfaceVariant: Palette.fgMuted,
    surfaceContainerLowest: Palette.sidebar,
    surfaceContainerLow: Palette.surface,
    surfaceContainer: Palette.surface,
    surfaceContainerHigh: Palette.raised,
    surfaceContainerHighest: Palette.muted,
    error: Palette.danger,
    outline: Palette.borderStrong,
    outlineVariant: Palette.border,
  );
  const text = TextTheme(
    displaySmall: TextStyle(
      fontSize: 32,
      fontWeight: FontWeight.w600,
      letterSpacing: -1,
      height: 1.15,
    ),
    headlineMedium: TextStyle(
      fontSize: 28,
      fontWeight: FontWeight.w600,
      letterSpacing: -.8,
      height: 1.2,
    ),
    headlineSmall: TextStyle(
      fontSize: 24,
      fontWeight: FontWeight.w600,
      letterSpacing: -.6,
    ),
    titleLarge: TextStyle(
      fontSize: 19,
      fontWeight: FontWeight.w600,
      letterSpacing: -.3,
    ),
    titleMedium: TextStyle(
      fontSize: 15.5,
      fontWeight: FontWeight.w600,
      letterSpacing: -.2,
    ),
    titleSmall: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
    bodyLarge: TextStyle(fontSize: 15.5, height: 1.5),
    bodyMedium: TextStyle(fontSize: 14.5, height: 1.5),
    bodySmall: TextStyle(fontSize: 12.5, color: Palette.fgMuted),
    labelLarge: TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
    labelMedium: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w500),
    labelSmall: TextStyle(
      fontSize: 11,
      fontWeight: FontWeight.w500,
      color: Palette.fgSubtle,
    ),
  );
  final field = OutlineInputBorder(
    borderRadius: BorderRadius.circular(Radii.md),
    borderSide: const BorderSide(color: Palette.border),
  );
  return ThemeData(
    brightness: Brightness.dark,
    useMaterial3: true,
    fontFamily: 'Geist',
    colorScheme: scheme,
    textTheme: text.apply(bodyColor: Palette.fg, displayColor: Palette.fg),
    scaffoldBackgroundColor: Palette.bg,
    canvasColor: Palette.bg,
    splashFactory: NoSplash.splashFactory,
    splashColor: Colors.transparent,
    highlightColor: Colors.transparent,
    hoverColor: const Color(0x0affffff),
    focusColor: const Color(0x14ffffff),
    dividerColor: Palette.border,
    dividerTheme: const DividerThemeData(
      color: Palette.border,
      thickness: 1,
      space: 1,
    ),
    iconTheme: const IconThemeData(color: Palette.fgMuted, size: 20),
    textSelectionTheme: const TextSelectionThemeData(
      cursorColor: Palette.primary,
      selectionColor: Color(0x557c83f7),
      selectionHandleColor: Palette.primary,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Palette.surface,
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
      hintStyle: const TextStyle(color: Palette.fgSubtle, fontSize: 14.5),
      prefixIconColor: Palette.fgSubtle,
      suffixIconColor: Palette.fgSubtle,
      border: field,
      enabledBorder: field,
      disabledBorder: field,
      focusedBorder: field.copyWith(
        borderSide: const BorderSide(color: Palette.primary, width: 1.4),
      ),
      errorBorder: field.copyWith(
        borderSide: const BorderSide(color: Palette.danger),
      ),
      focusedErrorBorder: field.copyWith(
        borderSide: const BorderSide(color: Palette.danger, width: 1.4),
      ),
      errorStyle: const TextStyle(color: Palette.danger, fontSize: 12),
    ),
    tooltipTheme: TooltipThemeData(
      decoration: BoxDecoration(
        color: Palette.raised,
        borderRadius: BorderRadius.circular(Radii.sm),
        border: Border.all(color: Palette.borderStrong),
      ),
      textStyle: const TextStyle(
        color: Palette.fg,
        fontSize: 12,
        fontFamily: 'Geist',
      ),
      waitDuration: const Duration(milliseconds: 400),
    ),
    popupMenuTheme: PopupMenuThemeData(
      color: Palette.raised,
      elevation: 12,
      shadowColor: Colors.black,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Radii.md),
        side: const BorderSide(color: Palette.borderStrong),
      ),
      textStyle: const TextStyle(fontSize: 14, color: Palette.fg),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: Palette.raised,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Radii.xl),
        side: const BorderSide(color: Palette.border),
      ),
    ),
    bottomSheetTheme: const BottomSheetThemeData(
      backgroundColor: Palette.raised,
      surfaceTintColor: Colors.transparent,
      modalBarrierColor: Color(0xaa000000),
      showDragHandle: false,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(26)),
      ),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: Palette.raised,
      elevation: 8,
      contentTextStyle: const TextStyle(
        color: Palette.fg,
        fontFamily: 'Geist',
        fontSize: 14,
      ),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Radii.md),
        side: const BorderSide(color: Palette.borderStrong),
      ),
    ),
    scrollbarTheme: ScrollbarThemeData(
      thickness: WidgetStateProperty.all(6),
      radius: const Radius.circular(6),
      thumbColor: WidgetStateProperty.all(const Color(0x22ffffff)),
    ),
    progressIndicatorTheme: const ProgressIndicatorThemeData(
      color: Palette.primary,
      strokeWidth: 2.2,
    ),
    pageTransitionsTheme: const PageTransitionsTheme(
      builders: {
        TargetPlatform.android: CupertinoPageTransitionsBuilder(),
        TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
        TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
      },
    ),
  );
}
