import fs from 'fs';
import path from 'path';
import { take, takeLatest, fork, select, put, call, cps } from 'redux-saga/effects';
import storage from 'electron-json-storage';
import Raven from 'raven-js';

import { remote } from 'electron';

import {
  jiraUploadWorklog, chronosBackendUploadWorklog,
  signUploadUrlForS3Bucket, uploadScreenshotOnS3Bucket,
} from 'api';

import * as types from '../constants/';
import { getRecentWorklogsGroupedByDate } from '../selectors/worklogs';
import { selectWorklog, setWorklogUploadState } from '../actions/worklogs';


function* saveWorklogAsOffline(err, worklog) {
  console.log(err);
  Raven.captureException(err);
  let offlineWorklogs = yield cps(storage.get, 'offlineWorklogs');
  if (Object.prototype.toString.call(offlineWorklogs) !== '[object Array]') {
    offlineWorklogs = [];
  }
  offlineWorklogs.push(worklog);
  yield cps(storage.set, 'offlineWorklogs', offlineWorklogs);
}


export function* findAndSelectWorlogByIssueId({ issueId }) {
  const recentWorkLogsGroupedByDate = yield select(getRecentWorklogsGroupedByDate);
  const recentWorkLogs = new Immutable.OrderedSet()
    .concat(...recentWorkLogsGroupedByDate.map(day => day.worklogs));
  const foundWorklog = recentWorkLogs.find(w => w.get('issueId') === issueId);
  if (foundWorklog) {
    yield put(selectWorklog(foundWorklog.get('id')));
  } else {
    yield put(selectWorklog(null));
  }
}

export function* uploadWorklog({
  issueId,
  timeSpentSeconds,
  comment,
  activity,
  screenshots,
  worklog_id,
}, offlineMode = false) {
  remote.getGlobal('sharedObj').uploading = true;
  let worklogId = worklog_id; // eslint-disable-line

  if (!offlineMode) {
    yield put(setWorklogUploadState(true));
  }

  let worklog = false;
  if (!worklogId) {
    const jiraWorklogData = {
      issueId,
      worklog: {
        timeSpentSeconds,
        comment,
      },
    };
    try {
      worklog = yield call(jiraUploadWorklog, jiraWorklogData);
      worklogId = worklog.id;
    } catch (err) {
      yield call(
        saveWorklogAsOffline,
        err,
        {
          ...jiraWorklogData,
          screenshots,
          activity,
          type: 'jiraUploadWorklog',
        },
      );
    }
  }
  if (worklogId) {
    const chronosWorklogData = {
      worklogId,
      issueId,
      timeSpentSeconds,
      comment,
      screenshots,
      activity,
    };
    try {
      yield call(chronosBackendUploadWorklog, chronosWorklogData);
    } catch (err) {
      yield call(
        saveWorklogAsOffline,
        err,
        {
          ...chronosWorklogData,
          type: 'chronosUploadWorklog',
        },
      );
    }
  }
  if (!offlineMode) {
    yield put({ type: types.CLEAR_CURRENT_SCREENSHOTS_LIST });
    yield put({ type: types.CLEAR_CURRENT_IDLE_LIST });
    yield put(setWorklogUploadState(false));
    yield put({ type: types.FETCH_ISSUE_REQUEST, payload: issueId });
  }

  if (!offlineMode && worklog) {
    yield put({ type: types.ADD_RECENT_WORKLOG, payload: worklog });
  }
  remote.getGlobal('sharedObj').uploading = false;
}

export function* watchSelectWorklogs() {
  yield takeLatest(
    types.SELECT_WORKLOG_BY_ISSUE_ID,
    findAndSelectWorlogByIssueId,
  );
}

export function* uploadScreenshot({
  screenshotTime,
  timestamp,
  lastScreenshotPath,
  lastScreenshotThumbPath,
}) {
  const isOffline = lastScreenshotPath.includes('offline_screens');
  if (!isOffline) {
    yield put({ type: types.SET_LAST_SCREENSHOT_TIME, payload: screenshotTime });
  }

  const fileName = path.basename(lastScreenshotPath);
  const thumbFilename = path.basename(lastScreenshotThumbPath);

  let error = false;
  let mainScreenError = true;
  let thumbScreenError = true;

  const image = yield cps(fs.readFile, lastScreenshotPath);
  const thumbImage = yield cps(fs.readFile, lastScreenshotThumbPath);

  try {
    const { url } = yield call(signUploadUrlForS3Bucket, fileName);
    yield uploadScreenshotOnS3Bucket({ url, image });
    mainScreenError = false;

    if (lastScreenshotThumbPath.length) {
      const thumbUrlData = yield call(signUploadUrlForS3Bucket, thumbFilename);
      yield uploadScreenshotOnS3Bucket({ url: thumbUrlData.url, thumbImage });
      thumbScreenError = false;
    } else {
      thumbScreenError = false;
    }
  } catch (err) {
    console.log(err);
    Raven.captureException(err);
    error = true;
  }

  if (!isOffline) {
    yield put({
      type: types.ADD_SCREENSHOT_TO_CURRENT_LIST,
      payload: { fileName, thumbFilename, screenshotTime, timestamp },
    });
  }

  if (error) {
    if (!isOffline) {
      if (mainScreenError) {
        fs.rename(lastScreenshotPath, `${remote.getGlobal('appDir')}/offline_screens/${fileName}`);
      }
      if (thumbScreenError) {
        fs.rename(lastScreenshotPath, `${remote.getGlobal('appDir')}/offline_screens/${thumbFilename}`);
      }
    }
  } else {
    yield cps(fs.unlink, lastScreenshotPath);
    if (lastScreenshotThumbPath.length) {
      yield cps(fs.unlink, lastScreenshotThumbPath);
    }
  }
  return error;
}

export function* uploadOfflineScreenshots() {
  while (true) {
    yield take(types.CHECK_OFFLINE_SCREENSHOTS);
    yield put({ type: types.SET_STATE_CHECK_OFFLINE_SCREENSHOTS, payload: true });
    const images = yield cps(fs.readdir, `${remote.getGlobal('appDir')}/offline_screens/`);
    for (const image of images.filter(i => i.split('.').slice(-1)[0] === 'png')) { // eslint-disable-line
      const error = yield uploadScreenshot(
        { lastScreenshotPath: `${remote.getGlobal('appDir')}/offline_screens/${image}` },
      );
      if (error) {
        break;
      }
    }
    yield put({ type: types.SET_STATE_CHECK_OFFLINE_SCREENSHOTS, payload: false });
  }
}

export function* uploadOfflineWorklogs() {
  while (true) {
    yield take(types.CHECK_OFFLINE_WORKLOGS);
    yield put({ type: types.SET_STATE_CHECK_OFFLINE_WORKLOGS, payload: true });
    let offlineWorklogs = yield cps(storage.get, 'offlineWorklogs');
    if (Object.prototype.toString.call(offlineWorklogs) !== '[object Array]') {
      offlineWorklogs = [];
    }
    let index = 0;
    for (const worklog of offlineWorklogs) { // eslint-disable-line
      const { issueId, screenshots, activity } = worklog;
      const args = { issueId, screenshots, activity };
      if (worklog.type === 'jiraUploadWorklog') {
        args.timeSpentSeconds = worklog.worklog.timeSpentSeconds;
        args.comment = worklog.worklog.comment;
      }
      if (worklog.type === 'chronosUploadWorklog') {
        args.timeSpentSeconds = worklog.timeSpentSeconds;
        args.worklog_id = worklog.worklogId;
        args.comment = worklog.comment;
      }
      const error = yield uploadWorklog(args, true);
      offlineWorklogs.splice(index, 1);
      if (error) {
        break;
      }
      index += 1;
    }
    yield cps(storage.set, 'offlineWorklogs', offlineWorklogs);
    yield put({ type: types.SET_STATE_CHECK_OFFLINE_WORKLOGS, payload: false });
  }
}


export function* watchUploadScreenshot() {
  while (true) {
    const { screenshotInfo } = yield take(types.UPLOAD_SCREENSHOT_REQUEST);
    yield fork(uploadScreenshot, screenshotInfo);
  }
}

export function* rejectScreenshot(screenshotPath) {
  const lastScreenshotTime = yield select(state => state.timer.lastScreenshotTime);
  yield put({ type: types.SET_TIME, payload: lastScreenshotTime });
  yield cps(fs.unlink, screenshotPath);
}

export function* watchRejectScreenshot() {
  while (true) {
    const { screenshotPath } = yield take(types.REJECT_SCREENSHOT_REQUEST);
    yield fork(rejectScreenshot, screenshotPath);
  }
}