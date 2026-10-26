// Apply the stored theme before first paint (next-themes takes over after mount).
// A file rather than an inline script, so the Content-Security-Policy can refuse inline scripts.
try {
  var t = localStorage.getItem('theme') || 'dark';
  if (t === 'system') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.classList.toggle('dark', t === 'dark');
  document.documentElement.style.colorScheme = t;
} catch (e) {}
