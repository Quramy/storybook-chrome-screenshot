import { EventEmitter } from 'events';
import * as path from 'path';
import puppeteer from 'puppeteer';
import * as qs from 'query-string';
import { CLIOptions } from '../../models/options';
import { StoredStory, StoryWithOptions } from '../../models/story';
import { EventTypes, PhaseIdentity, PhaseTypes } from '../constants';
import { knobsQueryObject } from '../utils';

export interface ConsoleHandler {
  (type: string, text: string): void;
}

export class Page extends EventEmitter {
  private page: puppeteer.Page;
  private url: string;
  private options: CLIOptions;
  private previous = '';

  private startTimer(msg: string) {
    const timer = setTimeout(() => {
      const e = new Error('Page Timeout ' + msg);
      throw e;
    }, 10000);
    return {
      stop: () => clearTimeout(timer),
    };
  }

  public constructor(
    page: puppeteer.Page,
    url: string,
    options: CLIOptions,
    consoleHandler: ConsoleHandler
  ) {
    super();

    this.page = page;
    this.url = url;
    this.options = options;

    this.page.on('console', (data: puppeteer.ConsoleMessage) => {
      if (typeof data.type === 'function') {
        consoleHandler(data.type(), data.text());
      } else {
        // it IS a string, by fact. Type definitions are wrong
        consoleHandler(data.type.toString(), <any>data.text);
      }
    });
  }

  public async goto(phase: string, query: object = {}) {
    const q = {
      ...query,
      full: 1,
      [PhaseIdentity]: phase
    };

    const url = `${this.url}?${qs.stringify(q)}`;

    await this.page.goto(url, {
      timeout: this.options.browserTimeout,
      waitUntil: ['domcontentloaded', 'networkidle2']
    });
  }

  private async gotoAndSelect(phase: string, query: object = {}) {
    const q = {
      ...query,
      full: 1,
      [PhaseIdentity]: phase
    };

    const url = `${this.url}?${qs.stringify(q)}`;

    const timer = this.startTimer('goto');
    if (this.previous && this.previous !== JSON.stringify(query)) {
      await this.page.evaluate((query: any) => {
        const api = (<any>window)['_api'];
        const client  = (<any>window)['_client'];
        api.setQueryParams(query);
        api.selectStory(query.selectKind, query.selectStory);
        client.run();
        return !!(<any>window)['_api'];
      }, q);
    } else {
      await this.page.goto(url, {
        timeout: this.options.browserTimeout,
        waitUntil: ['domcontentloaded', 'networkidle2']
      });
    }
    timer.stop();
    this.previous = query ? JSON.stringify(query) : '';
  }

  public async screenshot(story: StoredStory) {
    const { cwd, outputDir, injectFiles } = this.options;

    await this.page.setViewport({
      ...story.viewport,
      height: 1
    });

    await Promise.all([
      this.waitComponentReady(),
      this.gotoAndSelect(PhaseTypes.CAPTURE, {
        selectKind: story.kind,
        selectStory: story.story,
        ...knobsQueryObject(story.knobs)
      })
    ]);

    await this.page.bringToFront();

    const file = path.join(outputDir, story.filename);

    const injectFileTimer = this.startTimer('injectFiles');
    await Promise.all(
      injectFiles.map((fpath) =>
        this.page.addScriptTag({
          path: fpath
        })
      )
    );
    injectFileTimer.stop();

    const scTimer = this.startTimer('screenshot');
    await this.page.screenshot({
      path: path.resolve(cwd, file),
      fullPage: true
    });
    scTimer.stop();

    return file;
  }

  public exposeSetScreenshotStories() {
    return this.exposeFunction('setScreenshotStories', (stories: StoryWithOptions[]) => {
      this.emit('handleScreenshotStories', stories);
    });
  }

  public waitScreenshotStories() {
    return new Promise<StoryWithOptions[]>((resolve) => {
      this.once('handleScreenshotStories', (stories: StoryWithOptions[]) => {
        resolve(stories);
      });
    });
  }

  // tslint:disable-next-line: no-any
  public async exposeFunction(name: string, fn: (...args: any[]) => any) {
    return this.page.exposeFunction(name, fn);
  }

  private waitComponentReady() {
    const timer = this.startTimer('waitComponentReady');
    return new Promise((resolve) => {
      this.once(EventTypes.COMPONENT_READY, () => {
        timer.stop();
        resolve();
      });
    });
  }
}
