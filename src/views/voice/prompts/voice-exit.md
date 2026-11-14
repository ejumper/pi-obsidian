<!-- Injected once, on the first prompt after voice mode is switched off (i.e. the first
typed prompt after a voice turn). Everything below the `---` line is what the model sees.
Tunable at runtime: this file is read from the plugin's install dir (prompts/voice-exit.md);
the built-in copy is only the fallback for when the file is missing. Mirrors pi's read-mode
prompt-file convention. -->

---
<voice-mode>
IMPORTANT: VOICE MODE IS OFF. Return to sending normal responses. Every earlier voice-mode instruction in this conversation is superseded and no longer applies.

This remains in effect until a `<voice-mode>` block states otherwise.
</voice-mode>
