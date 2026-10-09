const DESTINATION = 'familyfocusmedical@mail.lyrebirdhealth.com';
const HANDLER = 'forwardFromSeptember4';
const START = Math.floor(
  Date.parse('2026-10-0T00:00:00+10:00') / 1000
) - 1;
// math.floor - rounds to the lowest integer
// there is math.round but yeah not good for date in iso
// yes reader i know i could write a function the fetch date in iso with tostringiso() method but i am lazy

// Forwards Inbox email received from 4 September 2026, then archives it.
// Originally it was created for 4 September 2026 but there are older iterations.
// I wish I knew at the time how to get better
// First Day off of each month I would review:
// April 'IamAFool.md'
// May 'MayTheForceBwithU.md'
// June 'DrinkMoreP-JuneJuice.md'
// July 'EOY.md'
// August 'MyBaby.md'
// September 'SuperDepressedButGettingThere.md'

function forwardFromSeptember4() {
  const query = // This is a fair important const you need keep nested in this function.
    `in:inbox after:${START} -in:sent -in:drafts -in:spam -in:trash`; // See the Start and scroll up. I declared the global const with math.floor and see the explanation - see the September.md for context

  const messageIds = []; // I love array. I have an array of strong emotions wanting to punch the closing square bracket. But serious keep the const nested as well.
  let pageToken; // let const is really important. You need to remember that once let is declared for a variable. it can not be access outside this function.
  // but the var was not given a value every time functio

  do {
    const page = Gmail.Users.Messages.list('me', {
      q: query,
      maxResults: 500,
      pageToken,
    });

    messageIds.push(
      ...(page.messages || []).map(message => message.id)
    );

    pageToken = page.nextPageToken;
  } while (pageToken);

   messageIds.forEach(messageId => {
    // Native Gmail forwarding preserves the email and original attachments.
    // GmailApp.getMessageById(messageId).forward(DESTINATION);

    // Archive only after forwarding succeeds.
     Gmail.Users.Messages.modify(
      {removeLabelIds: ['UNREAD']}, // follow the function of the parent.child.child.child to find the right api documentation
      'me',
      messageId
     );

    console.log("Log"+messageId); // just for reduntant purpose called logging
  });
}
