function a(t){if(t.command)return{text:t.command,incomplete:t.commandComplete===!1};const e=t.summary,o=!!(e&&(/\[redacted\]/.test(e)||/…$/.test(e.trim())));return{text:e,incomplete:o}}export{a};
