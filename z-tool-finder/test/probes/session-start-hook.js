process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: '<available-custom-tools>\nZTF_PROBE_MARKER_9f3a — probe tool alpha, use when testing P0-1 injection\n</available-custom-tools>'
  }
}) + '\n');
