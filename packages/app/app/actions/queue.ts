import logger from 'electron-timber';
import _, { isEmpty, isString } from 'lodash';
import { createStandardAction } from 'typesafe-actions';

import { StreamProvider, store, PlaylistHelper } from '@nuclear/core';
import { getTrackArtist } from '@nuclear/ui';
import { Track } from '@nuclear/ui/lib/types';

import { safeAddUuid } from './helpers';
import { pausePlayback, startPlayback } from './player';
import { QueueItem, QueueStore, TrackStream } from '../reducers/queue';
import { RootState } from '../reducers';
import { LocalLibraryState } from './local';
import { Queue } from './actionTypes';
import StreamProviderPlugin from '@nuclear/core/src/plugins/streamProvider';

type LocalTrack = Track & {
  local: true;
};

const isLocalTrack = (track: Track): track is LocalTrack => track.local;

const localTrackToQueueItem = (track: LocalTrack, local: LocalLibraryState): QueueItem => {
  const { streams, ...rest } = track;

  const matchingLocalTrack = local.tracks.find(localTrack => localTrack.uuid === track.uuid);

  const resolvedStream = !isEmpty(streams) 
    ? streams?.find(stream => stream.source === 'Local') 
    : {
      source: 'Local',
      stream: `file://${matchingLocalTrack.path}`,
      duration: matchingLocalTrack.duration
    } as TrackStream;

  return toQueueItem({
    ...rest,
    streams: [resolvedStream]
  });
};

const updateQueueStore = () => async (getState) => {
  const { queue } = getState();
  const formatedQueue = PlaylistHelper.formatTrackList(queue.queueItems);
  store.set('queue', { ...queue, queueItems: formatedQueue });
};

export const toQueueItem = (track: Track): QueueItem => ({
  ...track,
  artist: isString(track.artist) ? track.artist : track.artist.name,
  name: track.title ? track.title : track.name,
  streams: track.streams ?? []
});

const getSelectedStreamProvider = (getState) => {
  const {
    plugin: {
      plugins: { streamProviders },
      selected
    }
  } = getState();

  return _.find(streamProviders, { sourceName: selected.streamProviders });
};

export const getTrackStreams = async (
  track: Track | LocalTrack,
  selectedStreamProvider: StreamProvider
) => {
  if (isLocalTrack(track)) {
    return track.streams.filter((stream) => stream.source === 'Local');
  } else {
    return selectedStreamProvider.search({
      artist: getTrackArtist(track),
      track: track.name
    });
  }
};

const addQueueItem = (item: QueueItem) => ({
  type: Queue.ADD_QUEUE_ITEM,
  payload: { item }
});

export const updateQueueItem = (item: QueueItem) => ({
  type: Queue.UPDATE_QUEUE_ITEM,
  payload: { item }
});

const playNextItem = (item: QueueItem) => ({
  type: Queue.PLAY_NEXT_ITEM,
  payload: { item }
});

export const queueDrop = (paths) => ({
  type: Queue.QUEUE_DROP,
  payload: paths
});

export const streamFailed = () => ({
  type: Queue.STREAM_FAILED
});

export function repositionSong(itemFrom, itemTo) {
  return {
    type: Queue.REPOSITION_TRACK,
    payload: {
      itemFrom,
      itemTo
    }
  };
}

export const clearQueue = createStandardAction(Queue.CLEAR_QUEUE)();
export const nextSongAction = createStandardAction(Queue.NEXT_TRACK)();
export const previousSongAction = createStandardAction(Queue.PREVIOUS_TRACK)();
export const selectSong = createStandardAction(Queue.SELECT_TRACK)<number>();
export const playNext = (item: QueueItem) => addToQueue(item, true);

export const addToQueue =
  (item: QueueItem, asNextItem = false) =>
    async (dispatch, getState) => {
      const { local, connectivity }: RootState = getState();
      item = {
        ...safeAddUuid(item),
        streams: item.local ? item.streams : [],
        loading: false
      };

      const isAbleToAdd = (!connectivity && item.local) || connectivity;

      if (!isAbleToAdd) {
        return;
      }

      if (item.local) {
        dispatch(!asNextItem ? addQueueItem(localTrackToQueueItem(item as LocalTrack, local)) : playNextItem(localTrackToQueueItem(item as LocalTrack, local)));
      } else {
        dispatch(!asNextItem ? addQueueItem(item) : playNextItem(item));
      }

      const { queue } = getState();
      const formatedQueue = PlaylistHelper.formatTrackList(queue.queueItems);
      store.set('queue', { ...queue, queueItems: formatedQueue });
      // updateQueueStore();
    };

export const selectNewStream = (track: QueueItem, streamId: string) => async (dispatch, getState) => {
  const selectedStreamProvider: StreamProviderPlugin = getSelectedStreamProvider(getState);

  const oldStreamData = track.streams.find(stream => stream.id === streamId);
  const streamData = await selectedStreamProvider.getStreamForId(streamId);

  if (!streamData) {
    dispatch(removeFromQueue(track));
  } else {
    dispatch(
      updateQueueItem({
        ...track,
        streams: [
          {
            ...oldStreamData,
            stream: streamData.stream,
            duration: streamData.duration
          },
          ...track.streams.filter(stream => stream.id !== streamId)
        ]
      })
    );
  }

  logger.error('SELECT NEW STREAM');

  const { queue } = getState();
  const formatedQueue = PlaylistHelper.formatTrackList(queue.queueItems);
  store.set('queue', { ...queue, queueItems: formatedQueue });
};

export const findStreamsForTrack = (idx: number) => async (dispatch, getState) => {
  const {queue}: RootState = getState();

  const track = queue.queueItems[idx];

  if (track && !track.local && isEmpty(track.streams)) {
    dispatch(updateQueueItem({
      ...track,
      loading: true
    }));
    const selectedStreamProvider = getSelectedStreamProvider(getState);
    try {
      const streamData = await getTrackStreams(
        track,
        selectedStreamProvider
      );

      if (streamData === undefined) {
        dispatch(removeFromQueue(track));
      } else {
        dispatch(
          updateQueueItem({
            ...track,
            loading: false,
            error: false,
            streams: streamData
          })
        );
      }
    } catch (e) {
      logger.error(
        `An error has occurred when searching for streams with ${selectedStreamProvider.sourceName} for "${track.artist} - ${track.name}."`
      );
      logger.error(e);
      dispatch(
        updateQueueItem({
          ...track,
          loading: false,
          error: {
            message: `An error has occurred when searching for streams with ${selectedStreamProvider.sourceName}.`,
            details: e.message
          }
        })
      );
    }

    const { queue } = getState();
    const formatedQueue = PlaylistHelper.formatTrackList(queue.queueItems);
    store.set('queue', { ...queue, queueItems: formatedQueue });
  }
};

export function playTrack(streamProviders, item: QueueItem) {
  return (dispatch) => {
    dispatch(clearQueue());
    dispatch(addToQueue(item));
    dispatch(selectSong(0));
    dispatch(startPlayback(false));
  };
}

export const removeFromQueue = (item: QueueItem) => ({
  type: Queue.REMOVE_QUEUE_ITEM,
  payload: item
});

export function addPlaylistTracksToQueue(tracks) {
  return async (dispatch) => {
    await tracks.forEach(async (item) => {
      await dispatch(addToQueue(item));
    });
  };
}

function dispatchWithShuffle(dispatch, getState, action) {
  const { settings, queue } = getState();

  if (settings.shuffleQueue) {
    const index = _.random(0, queue.queueItems.length - 1);
    dispatch(selectSong(index));
  } else {
    dispatch(action());
  }

  const formatedQueue = PlaylistHelper.formatTrackList(queue.queueItems);
  store.set('queue', { ...queue, queueItems: formatedQueue });
}

export function previousSong() {
  return (dispatch, getState) => {
    const {settings, queue} = getState();

    if (settings.shuffleWhenGoingBack) {
      dispatchWithShuffle(dispatch, getState, previousSongAction);
    } else {
      dispatch(previousSongAction());
    }

    const formatedQueue = PlaylistHelper.formatTrackList(queue.queueItems);
    store.set('queue', { ...queue, queueItems: formatedQueue });
  };
}

export function nextSong() {
  return (dispatch, getState) => {
    dispatchWithShuffle(dispatch, getState, nextSongAction);
    dispatch(pausePlayback(false));
    setImmediate(() => dispatch(startPlayback(false)));

    const { queue } = getState();
    const formatedQueue = PlaylistHelper.formatTrackList(queue.queueItems);
    store.set('queue', { ...queue, queueItems: formatedQueue });
  };
}
