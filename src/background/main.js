import browser from 'webextension-polyfill';
import _ from 'lodash';
import uuidV4 from 'uuid/v4';

import storage from 'storage/storage';
import {
  getText,
  createTab,
  executeCode,
  executeFile,
  scriptsAllowed,
  onComplete,
  getRandomString,
  getRandomInt,
  dataUriToBlob,
  getDataUriMimeType
} from 'utils/common';
import {
  getEnabledEngines,
  showNotification,
  getRandomFilename
} from 'utils/app';
import {optionKeys, engines, imageMimeTypes} from 'utils/data';
import {targetEnv} from 'utils/config';

const dataStore = {};

function storeData(data) {
  data = _.cloneDeep(data);
  const dataKey = uuidV4();
  dataStore[dataKey] = data;
  return dataKey;
}

function deleteData(dataKey) {
  if (dataStore.hasOwnProperty(dataKey)) {
    delete dataStore[dataKey];
    return true;
  }
}

function createMenuItem({
  id,
  title = '',
  contexts,
  parent,
  type = 'normal',
  urlPatterns
}) {
  browser.contextMenus.create(
    {
      id,
      title,
      contexts,
      documentUrlPatterns: urlPatterns,
      parentId: parent,
      type
    },
    onComplete
  );
}

async function createMenu(options) {
  const enEngines = await getEnabledEngines(options);
  const contexts = [
    'audio',
    'editable',
    'frame',
    'image',
    'link',
    'page',
    'selection',
    'video'
  ];
  const urlPatterns = ['http://*/*', 'https://*/*', 'ftp://*/*'];
  if (targetEnv === 'firefox') {
    urlPatterns.push('file:///*');
  }

  if (enEngines.length === 1) {
    const engine = enEngines[0];
    createMenuItem({
      id: engine,
      title: getText(
        'mainMenuItemTitle_engine',
        getText(`menuItemTitle_${engine}`)
      ),
      contexts,
      urlPatterns
    });
    return;
  }

  if (enEngines.length > 1) {
    const searchAllEngines = options.searchAllEnginesContextMenu;

    if (searchAllEngines === 'main') {
      createMenuItem({
        id: 'allEngines',
        title: getText('mainMenuItemTitle_allEngines'),
        contexts,
        urlPatterns
      });
      return;
    }

    createMenuItem({
      id: 'par-1',
      title: getText('mainMenuGroupTitle_searchImage'),
      contexts,
      urlPatterns
    });

    if (searchAllEngines === 'sub') {
      createMenuItem({
        id: 'allEngines',
        title: getText('menuItemTitle_allEngines'),
        contexts,
        parent: 'par-1',
        urlPatterns
      });
      createMenuItem({
        id: 'sep-1',
        contexts,
        parent: 'par-1',
        type: 'separator',
        urlPatterns
      });
    }

    enEngines.forEach(function(engine) {
      createMenuItem({
        id: engine,
        title: getText(`menuItemTitle_${engine}`),
        contexts,
        parent: 'par-1',
        urlPatterns
      });
    });
  }
}

async function getTabUrl(imgData, engine, options) {
  let tabUrl;

  if (imgData.isBlob) {
    tabUrl = engines[engine].upload;
    if (['google', 'tineye'].includes(engine)) {
      tabUrl = tabUrl.replace('{dataKey}', imgData.dataKey);
    }
  } else {
    tabUrl = engines[engine].url.replace(
      '{imgUrl}',
      encodeURIComponent(imgData.url)
    );
    if (engine === 'google' && !options.localGoogle) {
      tabUrl = `${tabUrl}&gws_rd=cr`;
    }
  }

  return tabUrl;
}

async function searchImage(img, engine, sourceTabIndex, receiptKey = null) {
  const options = await storage.get(optionKeys, 'sync');

  let tabIndex = sourceTabIndex + 1;
  let tabActive = !options.tabInBackgound;
  let dataKey = '';
  const imgData = {
    isBlob: _.has(img, 'objectUrl') || img.data.startsWith('data:')
  };

  if (imgData.isBlob) {
    if (!_.has(img, 'info.filename') || !img.info.filename) {
      const ext = _.get(imageMimeTypes, getDataUriMimeType(img.data), '');
      const filename = getRandomString(getRandomInt(5, 20));
      imgData.filename = ext ? `${filename}.${ext}` : filename;
    } else {
      imgData.filename = img.info.filename;
    }
    if (!_.has(img, 'objectUrl')) {
      imgData.objectUrl = URL.createObjectURL(dataUriToBlob(img.data));
    } else {
      imgData.objectUrl = img.objectUrl;
    }
    imgData.receiptKey = receiptKey;
    imgData.dataKey = storeData(imgData);
    window.setTimeout(function() {
      const newDelete = deleteData(imgData.dataKey);
      if (newDelete && imgData.isBlob && !imgData.receiptKey) {
        URL.revokeObjectURL(imgData.objectUrl);
      }
    }, 120000); // 2 minutes
  } else {
    imgData.url = img.data;
  }

  if (engine === 'allEngines') {
    for (const engine of await getEnabledEngines(options)) {
      await searchEngine(imgData, engine, options, tabIndex, tabActive);
      tabIndex = tabIndex + 1;
      tabActive = false;
    }
  } else {
    await searchEngine(imgData, engine, options, tabIndex, tabActive);
  }
}

async function searchEngine(imgData, engine, options, tabIndex, tabActive) {
  const tabUrl = await getTabUrl(imgData, engine, options);
  const tab = await createTab(tabUrl, tabIndex, tabActive);

  if (imgData.dataKey) {
    const cssNeeded = ['bing'];
    if (cssNeeded.includes(engine)) {
      browser.tabs.insertCSS(tab.id, {
        runAt: 'document_start',
        file: '/src/content/engines/style.css'
      });
    }

    const commonNeeded = ['bing', 'yandex', 'baidu', 'sogou'];
    if (commonNeeded.includes(engine)) {
      executeFile(`/src/content/common.js`, tab.id, 0, 'document_idle');
    }

    const supportedEngines = ['bing', 'yandex', 'baidu', 'sogou'];
    if (supportedEngines.includes(engine)) {
      executeCode(`var dataKey = '${imgData.dataKey}';`, tab.id);
      executeFile(
        `/src/content/engines/${engine}.js`,
        tab.id,
        0,
        'document_idle'
      );
    }
  }
}

async function searchClickTarget(engine, tabId, tabIndex, frameId) {
  const [probe] = await executeCode('frameStore;', tabId, frameId);

  const {imgFullParse} = await storage.get('imgFullParse', 'sync');
  await executeCode(
    `frameStore.options.imgFullParse = ${imgFullParse};`,
    tabId,
    frameId
  );

  if (!probe.modules.parse) {
    await executeFile('/src/content/parse.js', tabId, frameId);
    await rememberExecution('parse', tabId, frameId);
  }

  let [images] = await executeCode('parseDocument();', tabId, frameId);

  if (!images) {
    await showNotification('error_InternalError');
    return;
  }

  if (images.length === 0) {
    await showNotification('error_imageNotFound');
    return;
  }

  images = _.uniqBy(images, 'data');

  if (images.length > 1) {
    const [probe] = await executeCode('frameStore;', tabId);
    if (!probe.modules.confirm) {
      await rememberExecution('confirm', tabId);

      await browser.tabs.insertCSS(tabId, {
        runAt: 'document_start',
        file: '/src/confirm/frame.css'
      });

      await executeFile('/src/content/confirm.js', tabId);
    }

    await browser.tabs.sendMessage(
      tabId,
      {
        id: 'imageConfirmationOpen',
        images,
        engine
      },
      {frameId: 0}
    );
  } else {
    await searchImage(images[0], engine, tabIndex);
  }
}

async function onContextMenuItemClick(info, tab) {
  const tabId = tab.id;
  const tabIndex = tab.index;
  const frameId = typeof info.frameId !== 'undefined' ? info.frameId : 0;
  const engine = info.menuItemId;

  if (!await scriptsAllowed(tabId, frameId)) {
    if (info.srcUrl) {
      await searchImage({data: info.srcUrl}, engine, tabIndex);
    } else {
      await showNotification('error_scriptsNotAllowed');
    }
    return;
  }

  // Firefox < 55.0
  if (
    !frameId &&
    typeof info.frameUrl !== 'undefined' &&
    info.pageUrl !== info.frameUrl
  ) {
    if (info.srcUrl) {
      await searchImage({data: info.srcUrl}, engine, tabIndex);
    } else {
      await showNotification('error_imageNotFound');
    }
    return;
  }

  await searchClickTarget(engine, tabId, tabIndex, frameId);
}

function rememberExecution(module, tabId, frameId = 0) {
  return executeCode(`frameStore.modules.${module} = true;`, tabId, frameId);
}

async function onActionClick(tabIndex, tabId, tabUrl, engine, searchMode) {
  if (searchMode === 'upload') {
    const browseUrl = browser.extension.getURL('/src/browse/index.html');
    await createTab(`${browseUrl}?engine=${engine}`, tabIndex + 1, true, tabId);
    return;
  }

  if (searchMode === 'select') {
    if (tabUrl.startsWith('file:') && targetEnv !== 'firefox') {
      await showNotification('error_invalidImageUrl_fileUrl');
      return;
    }

    if (!await scriptsAllowed(tabId)) {
      await showNotification('error_scriptsNotAllowed');
      return;
    }

    const [probe] = await executeCode('frameStore;', tabId);
    if (!probe.modules.select) {
      await rememberExecution('select', tabId);

      await browser.tabs.insertCSS(tabId, {
        runAt: 'document_start',
        file: '/src/select/frame.css'
      });

      await executeFile('/src/content/select.js', tabId);
    }

    await browser.tabs.executeScript(tabId, {
      allFrames: true,
      runAt: 'document_start',
      code: `
        addClickListener();
        showPointer();
        frameStore.data.engine = '${engine}';
      `
    });

    await browser.tabs.sendMessage(
      tabId,
      {
        id: 'imageSelectionOpen'
      },
      {frameId: 0}
    );

    return;
  }
}

async function onActionButtonClick(tab) {
  const options = await storage.get(
    [
      'engines',
      'disabledEngines',
      'searchAllEnginesAction',
      'searchModeAction'
    ],
    'sync'
  );

  if (options.searchModeAction === 'url' && targetEnv !== 'firefox') {
    await showNotification('error_invalidSearchMode_url');
    return;
  }

  const enEngines = await getEnabledEngines(options);

  if (enEngines.length === 0) {
    await showNotification('error_allEnginesDisabled');
    return;
  }

  let engine = null;
  if (options.searchAllEnginesAction === 'main' && enEngines.length > 1) {
    engine = 'allEngines';
  } else {
    engine = enEngines[0];
  }

  onActionClick(tab.index, tab.id, tab.url, engine, options.searchModeAction);
}

async function onActionPopupClick(engine, imageUrl) {
  const {searchModeAction} = await storage.get('searchModeAction', 'sync');

  const [tab, ...rest] = await browser.tabs.query({
    lastFocusedWindow: true,
    active: true
  });
  const tabIndex = tab.index;

  if (searchModeAction === 'url') {
    await searchImage({data: imageUrl}, engine, tabIndex);
    return;
  }

  onActionClick(tabIndex, tab.id, tab.url, engine, searchModeAction);
}

async function onMessage(request, sender, sendResponse) {
  if (request.id === 'imageDataRequest') {
    const imgData = dataStore[request.dataKey];
    const response = {id: 'imageDataResponse'};
    if (imgData) {
      response['imgData'] = imgData;
    } else {
      response['error'] = 'sessionExpired';
    }
    browser.tabs.sendMessage(sender.tab.id, response, {frameId: 0});
    return;
  }

  if (request.id === 'actionPopupSubmit') {
    onActionPopupClick(request.engine, request.imageUrl);
    return;
  }

  if (request.id === 'imageUploadSubmit') {
    const tabId = sender.tab.id;
    const receiptKey = storeData({
      total: request.searchCount,
      receipts: 0,
      tabId
    });
    window.setTimeout(function() {
      const newDelete = deleteData(receiptKey);
      if (newDelete) {
        browser.tabs.remove(tabId);
      }
    }, 120000); // 2 minutes
    for (let img of request.images) {
      await searchImage(img, request.engine, sender.tab.index, receiptKey);
    }
    return;
  }

  if (request.id === 'imageUploadReceipt') {
    const receiptData = dataStore[request.receiptKey];
    if (receiptData) {
      receiptData.receipts += 1;
      if (receiptData.receipts === receiptData.total) {
        deleteData(request.receiptKey);
        browser.tabs.remove(receiptData.tabId);
      }
    }
    return;
  }

  if (request.id === 'imageSelectionSubmit') {
    browser.tabs.executeScript(sender.tab.id, {
      allFrames: true,
      runAt: 'document_start',
      code: `
        removeClickListener();
        hidePointer();
      `
    });
    browser.tabs.sendMessage(
      sender.tab.id,
      {id: 'imageSelectionClose', messageFrame: true},
      {frameId: 0}
    );
    searchClickTarget(
      request.engine,
      sender.tab.id,
      sender.tab.index,
      sender.frameId
    );
    return;
  }

  if (request.id === 'imageSelectionCancel') {
    browser.tabs.executeScript(sender.tab.id, {
      allFrames: true,
      runAt: 'document_start',
      code: `
        removeClickListener();
        hidePointer();
      `
    });
    browser.tabs.sendMessage(
      sender.tab.id,
      {id: 'imageSelectionClose'},
      {frameId: 0}
    );
    return;
  }

  if (request.id === 'imageConfirmationSubmit') {
    browser.tabs.sendMessage(
      sender.tab.id,
      {id: 'imageConfirmationClose'},
      {frameId: 0}
    );
    searchImage(request.img, request.engine, sender.tab.index);
    return;
  }

  if (request.id === 'imageConfirmationCancel') {
    browser.tabs.sendMessage(
      sender.tab.id,
      {id: 'imageConfirmationClose'},
      {frameId: 0}
    );
    return;
  }

  if (request.id.endsWith('FrameId')) {
    browser.tabs.sendMessage(
      sender.tab.id,
      {id: request.id, frameId: sender.frameId},
      {frameId: 0}
    );
    return;
  }

  if (request.id === 'notification') {
    showNotification(request.messageId, request.type);
    return;
  }

  if (request.id === 'routeMessage') {
    const params = [
      request.hasOwnProperty('tabId') ? request.tabId : sender.tab.id,
      request.data
    ];
    if (request.hasOwnProperty('frameId')) {
      params.push({frameId: request.frameId});
    }
    browser.tabs.sendMessage(...params);
    return;
  }
}

async function onStorageChange(changes, area) {
  await setContextMenu({removeFirst: true});
  await setBrowserAction();
}

async function setContextMenu({removeFirst = false} = {}) {
  if (removeFirst) {
    await browser.contextMenus.removeAll();
  }
  const options = await storage.get(optionKeys, 'sync');
  const hasListener = browser.contextMenus.onClicked.hasListener(
    onContextMenuItemClick
  );
  if (options.showInContextMenu === true) {
    if (!hasListener) {
      browser.contextMenus.onClicked.addListener(onContextMenuItemClick);
    }
    await createMenu(options);
  } else {
    if (hasListener) {
      browser.contextMenus.onClicked.removeListener(onContextMenuItemClick);
    }
  }
}

async function setBrowserAction() {
  const options = await storage.get(
    ['engines', 'disabledEngines', 'searchAllEnginesAction'],
    'sync'
  );
  const enEngines = await getEnabledEngines(options);
  const hasListener = browser.browserAction.onClicked.hasListener(
    onActionButtonClick
  );

  if (enEngines.length === 1) {
    if (!hasListener) {
      browser.browserAction.onClicked.addListener(onActionButtonClick);
    }
    browser.browserAction.setTitle({
      title: getText(
        'actionTitle_engine',
        getText(`menuItemTitle_${enEngines[0]}`)
      )
    });
    browser.browserAction.setPopup({popup: ''});
    return;
  }

  if (options.searchAllEnginesAction === 'main' && enEngines.length > 1) {
    if (!hasListener) {
      browser.browserAction.onClicked.addListener(onActionButtonClick);
    }
    browser.browserAction.setTitle({
      title: getText('actionTitle_allEngines')
    });
    browser.browserAction.setPopup({popup: ''});
    return;
  }

  browser.browserAction.setTitle({title: getText('extensionName')});
  if (enEngines.length === 0) {
    if (!hasListener) {
      browser.browserAction.onClicked.addListener(onActionButtonClick);
    }
    browser.browserAction.setPopup({popup: ''});
  } else {
    if (hasListener) {
      browser.browserAction.onClicked.removeListener(onActionButtonClick);
    }
    browser.browserAction.setPopup({popup: '/src/action/index.html'});
  }
}

function addStorageListener() {
  browser.storage.onChanged.addListener(onStorageChange);
}

function addMessageListener() {
  browser.runtime.onMessage.addListener(onMessage);
}

async function onLoad() {
  await storage.init('sync');
  await setContextMenu();
  await setBrowserAction();
  addStorageListener();
  addMessageListener();
}

document.addEventListener('DOMContentLoaded', onLoad);