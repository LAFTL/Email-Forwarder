// Written in Java script - Please see 'What is a trigger' file for more info
// Run once to install one trigger that runs every 30 minutes.

function installForwarder() {
  ScriptApp.getProjectTriggers()
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger(HANDLER)
    .timeBased()
    .everyMinutes(30)
    .create();
}
