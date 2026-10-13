// Written in Java script - Please see 'What is a trigger' file for more info
// Run once to install one trigger that runs every 30 minutes.

function installForwarder() {
  // Replace this handler's timer. Leave unrelated triggers alone.
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === HANDLER &&
      trigger.getEventType() === ScriptApp.EventType.CLOCK)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger(HANDLER)
    .timeBased()
    .everyMinutes(30)
    .create();
}
