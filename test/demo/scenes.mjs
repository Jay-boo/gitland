// The README GIFs, one scene each (record.mjs drives them). `d` is the Director: move / click /
// hover / type / key / cmd / open / caption / find / wait. Targets are CSS or Playwright
// selectors, looked up in the workbench and in every webview. `setup` runs before the capture.

/** Collapses the Gitland sidebar sections named in `names` (clicks their headers). */
async function collapse(d, names) {
  for (const n of names) {
    await d.page.locator(`.pane-header[aria-expanded="true"]:has(h3.title:text-is("${n}"))`).first().click().catch(() => {});
    await d.wait(300);
  }
}

/** Puts the editor cursor at the end of the line containing `text` and returns where the code ends. */
async function lineEnd(d, text) {
  const line = await d.find(`.view-line:has-text("${text}")`);
  const box = await line.boundingBox();
  const right = await line.evaluate((el) => Math.max(...[...el.querySelectorAll('span[class^="mtk"]')].map((s) => s.getBoundingClientRect().right)));
  return { x: right, y: box.y + box.height / 2 };
}

export const SCENES = {
  graph: {
    async setup(d) {
      await d.key('Control+B');
      await d.cmd('Gitland: Show Commit Graph in Editor', { typeDelay: 0 });
      await d.find('.row.commit');
      await d.wait(2500);
    },
    async run(d) {
      await d.caption('<b>Commit Graph</b> · branches, pull requests and CI at a glance');
      await d.wait(1000);
      await d.hover('.row.commit:has-text("Pay part of the order with a gift card") .c-msg .subject', 2600);
      await d.caption('Click a branch: its history stays bright, the rest fades');
      await d.click('.row.commit .c-msg >> text=feature/1256-saved-carts');
      await d.wait(1800);
      await d.key('Escape');
      await d.caption('<b>Timeline</b> · one row per merged pull request');
      await d.click('#scope >> text=Timeline');
      await d.wait(2400);
      await d.caption('Commit details, changed files, one click to the diff');
      await d.click('#scope >> text=All');
      await d.wait(700);
      await d.click('.row.commit:has-text("Theme switch in the header") .c-msg .subject');
      await d.wait(2800);
      await d.caption('');
      await d.wait(400);
    },
  },

  blame: {
    async setup(d) {
      await d.key('Control+B');
      await d.open('src/checkout/cart.ts', 26);
      await d.wait(1500);
    },
    async run(d) {
      await d.caption('<b>Inline blame</b> · author, age and message on the current line');
      await d.wait(800);
      const end = await lineEnd(d, 'const discount');
      await d.click({ x: end.x - 30, y: end.y });
      await d.key('End');
      await d.wait(1800);
      await d.caption('Hover it: the pull request that brought the change, links, actions');
      await d.hover({ x: end.x + 140, y: end.y }, 3800);
      await d.move({ x: end.x + 140, y: end.y + 260 }, 500);
      await d.key('Escape');
      await d.caption('<b>File blame</b> with a heat bar · <kbd>Ctrl+Alt+B</kbd>');
      await d.key('Control+Alt+B');
      await d.wait(2800);
      await d.caption('');
      await d.wait(300);
    },
  },

  explain: {
    async setup(d) {
      await d.key('Control+B');
      await d.open('src/checkout/cart.ts', 31);
      for (let i = 0; i < 7; i++) await d.key('Shift+ArrowDown');
      await d.wait(800);
    },
    async run(d) {
      await d.caption('✨ <b>Why are these lines like this?</b>');
      await d.wait(1200);
      await d.cmd('Gitland: Explain These Lines', { typeDelay: 45, pause: 500 });
      await d.find('text=Explanation');
      await d.caption('Line history + an AI summary of the commits, PRs and tickets behind it');
      await d.wait(6500);
      await d.caption('');
      await d.wait(300);
    },
  },

  tickets: {
    async setup(d) {
      await d.signIn();
      await d.page.locator('.activitybar [aria-label^="Gitland"]').first().click();
      await d.wait(1500);
      await collapse(d, ['Changes', 'Graph', 'Pull Requests']);
      await d.find('.item:has-text("estimated delivery")');
      await d.wait(1200);
    },
    async run(d) {
      await d.caption('<b>My Tickets</b> · your Azure DevOps work items, next to the code');
      await d.hover('.item:has-text("estimated delivery")', 1500);
      await d.caption('Start work: the branch is named after the ticket');
      await d.click('.item:has-text("estimated delivery") [data-act="start"]');
      await d.wait(1800);
      await d.key('Enter');
      await d.wait(1100);
      await d.key('Enter');
      await d.wait(1000);
      await d.type('origin/develop', 45);
      await d.wait(600);
      await d.key('Enter');
      await d.wait(1000);
      await d.caption('…and a draft pull request linked to it, in one step');
      await d.key('ArrowDown');
      await d.wait(700);
      await d.key('Enter');
      await d.find('.notification-toast:has-text("Draft pull request")');
      await d.wait(1800);
      await d.caption('Pull requests, reviews and CI stay in the sidebar');
      await d.click('.pane-header:has(h3.title:text-is("Pull Requests"))');
      await d.wait(2800);
      await d.caption('');
      await d.wait(300);
    },
  },

  compare: {
    async setup(d) {
      await d.key('Control+B');
      await d.cmd('Gitland: Show Commit Graph in Editor', { typeDelay: 0 });
      await d.find('.row.commit');
      await d.wait(2000);
    },
    async run(d) {
      await d.caption('<b>Compare</b> two tags, branches or commits');
      await d.wait(900);
      await d.click('.row.commit .c-msg >> text=v1.2.0', { button: 'right' });
      await d.wait(900);
      await d.click('text=Compare with the previous tag');
      await d.find('[data-act="notes"]');
      await d.caption('Pull requests merged, commits on each side, files changed');
      await d.wait(2600);
      await d.caption('✨ Release notes, in the style of your CHANGELOG');
      await d.click('[data-act="notes"]');
      await d.wait(6000);
      await d.caption('');
      await d.wait(300);
    },
  },

  dashboard: {
    async setup(d) {
      await d.signIn();
      await d.key('Control+B');
      await d.wait(500);
    },
    async run(d) {
      await d.cmd('Gitland: Dashboard', { typeDelay: 40, pause: 400 });
      await d.find('text=What needs you');
      await d.caption('<b>Dashboard</b> · reviews waiting, failing CI, tickets, branches');
      await d.wait(2600);
      await d.caption('Open a pull request: description, reviewers, CI, threads');
      await d.click('text=Gift cards: pay part of the order (AB#1251) >> nth=0');
      await d.wait(4000);
      await d.move({ x: 900, y: 600 }, 700);
      await d.page.mouse.wheel(0, 500);
      await d.wait(2600);
      await d.caption('');
      await d.wait(300);
    },
  },

  /** Not a GIF: screenshots of every view, to write the scenes against. */
  explore: {
    record: false,
    async run(d) {
      await d.signIn();
      await d.shot('00-start');
      await d.cmd('Gitland: Show Commit Graph in Editor', { typeDelay: 0 });
      await d.wait(4000);
      await d.shot('01-graph-editor');
      await d.closeAll();
      await d.page.locator('.activitybar [aria-label^="Gitland"]').first().click();
      await d.wait(4000);
      await d.shot('02-sidebar');
      await d.open('src/checkout/cart.ts', 36);
      await d.wait(2500);
      await d.shot('03-editor-blame');
      await d.cmd('Gitland: Dashboard', { typeDelay: 0 });
      await d.wait(4000);
      await d.shot('04-dashboard');
    },
  },
};
