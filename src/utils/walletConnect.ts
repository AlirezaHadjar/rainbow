import SignClient from '@walletconnect/sign-client';
import { SignClientTypes } from '@walletconnect/types';
import { getSdkError, parseUri } from '@walletconnect/utils';
import { WC_PROJECT_ID } from 'react-native-dotenv';
import { NavigationContainerRef } from '@react-navigation/native';
import Minimizer from 'react-native-minimizer';
import { utils as ethersUtils } from 'ethers';
import { formatJsonRpcResult, formatJsonRpcError } from '@json-rpc-tools/utils';

import { logger, RainbowError } from '@/logger';
import { WalletconnectApprovalSheetRouteParams } from '@/redux/walletconnect';
import { Navigation } from '@/navigation';
import { getActiveRoute } from '@/navigation/Navigation';
import Routes from '@/navigation/routesNames';
import { analytics } from '@/analytics';
import { maybeSignUri } from '@/handlers/imgix';
import { dappLogoOverride, dappNameOverride } from '@/helpers/dappNameHandler';
import { Alert } from '@/components/alerts';
import * as lang from '@/languages';
import {
  isSigningMethod,
  isTransactionDisplayType,
} from '@/utils/signingMethods';
import store from '@/redux/store';
import { findWalletWithAccount } from '@/helpers/findWalletWithAccount';
import WalletTypes from '@/helpers/walletTypes';
import { ethereumUtils } from '@/utils';
import { getRequestDisplayDetails } from '@/parsers';
import {
  RequestData,
  REQUESTS_UPDATE_REQUESTS_TO_APPROVE,
  removeRequest,
} from '@/redux/requests';
import { saveLocalRequests } from '@/handlers/localstorage/walletconnectRequests';

/**
 * Indicates that the app should redirect or go back after the next action
 * completes
 *
 * This is a hack to get around having to muddy the scopes of our event
 * listeners. BE CAREFUL WITH THIS.
 */
let hasDeeplinkPendingRedirect = false;

/**
 * Set `hasDeeplinkPendingRedirect` to a boolean, indicating that the app
 * should redirect or go back after the next action completes
 *
 * This is a hack to get around having to muddy the scopes of our event
 * listeners. BE CAREFUL WITH THIS.
 */
export function setHasPendingDeeplinkPendingRedirect(value: boolean) {
  logger.info(`setHasPendingDeeplinkPendingRedirect`, { value });
  hasDeeplinkPendingRedirect = value;
}

const signClient = Promise.resolve(
  SignClient.init({
    projectId: WC_PROJECT_ID,
    // relayUrl: "<YOUR RELAY URL>",
    metadata: {
      name: '🌈 Rainbow',
      description: 'Rainbow makes exploring Ethereum fun and accessible 🌈',
      url: 'https://rainbow.me',
      icons: ['https://avatars2.githubusercontent.com/u/48327834?s=200&v=4'],
    },
  })
);

/**
 * For RPC requests that have [address, message] tuples (order may change),
 * return { address, message } and JSON.parse the value if it's from a typed
 * data request
 */
function parseRPCParams({
  method,
  params,
}: {
  method: string;
  params: string[];
}) {
  if (method === 'eth_sign' || method === 'personal_sign') {
    const [address, message] = params.sort(a =>
      ethersUtils.isAddress(a) ? -1 : 1
    );
    const isHexString = ethersUtils.isHexString(message);

    const decodedMessage = isHexString
      ? ethersUtils.toUtf8String(message)
      : message;

    return {
      address,
      message: decodedMessage,
    };
  }

  if (method === 'eth_signTypedData' || method === 'eth_signTypedData_v4') {
    const [address, message] = params.sort(a =>
      ethersUtils.isAddress(a) ? -1 : 1
    );

    return {
      address,
      message: JSON.parse(message),
    };
  }

  return {};
}

export async function pair({ uri }: { uri: string }) {
  logger.debug(`WC v2: pair`, { uri });

  // show loading state as feedback for user
  Navigation.handleAction(Routes.WALLET_CONNECT_APPROVAL_SHEET, {});

  const receivedTimestamp = Date.now();
  const { topic } = parseUri(uri);
  const client = await signClient;

  await client.core.pairing.pair({ uri });

  const timeout = setTimeout(() => {
    const route: ReturnType<
      NavigationContainerRef['getCurrentRoute']
    > = getActiveRoute();

    if (!route) return;

    /**
     * If user is still looking at the approval sheet, show them the failure
     * state. Otherwise, do nothing
     */
    if (route.name === Routes.WALLET_CONNECT_APPROVAL_SHEET) {
      const routeParams: WalletconnectApprovalSheetRouteParams = {
        receivedTimestamp,
        timedOut: true,
        // empty, the sheet will show the error state
        async callback() {},
      };

      // end load state with `timedOut` and provide failure callback
      Navigation.handleAction(
        Routes.WALLET_CONNECT_APPROVAL_SHEET,
        routeParams,
        true
      );
    }

    analytics.track('New WalletConnect session time out');
  }, 20_000);

  function handler(
    proposal: SignClientTypes.EventArguments['session_proposal']
  ) {
    // listen for THIS topic pairing, and clear timeout if received
    if (proposal.params.pairingTopic === topic) {
      client.off('session_proposal', handler);
      clearTimeout(timeout);
    }
  }

  client.on('session_proposal', handler);
}

export async function initListeners() {
  const client = await signClient;

  logger.debug(`WC v2: signClient initialized, initListeners`);

  client.on('session_proposal', onSessionProposal);
  client.on('session_request', onSessionRequest);
}

export function onSessionProposal(
  proposal: SignClientTypes.EventArguments['session_proposal']
) {
  logger.debug(`WC v2: session_proposal`, { event: proposal });

  const receivedTimestamp = Date.now();
  const {
    proposer,
    expiry, // TODO do we need to do anything with this?
    requiredNamespaces,
  } = proposal.params;

  /**
   * Trying to be defensive here, but I'm not sure we support this anyway so
   * probably not a big deal right now.
   */
  if (!requiredNamespaces.eip155) {
    logger.error(new RainbowError(`WC v2: missing required namespace eip155`));
    return;
  }

  const { chains } = requiredNamespaces.eip155;
  const chainId = parseInt(chains[0].split('eip155:')[1]);
  const peerMeta = proposer.metadata;
  const dappName = dappNameOverride(peerMeta.name) || 'Unknown Dapp';

  const routeParams: WalletconnectApprovalSheetRouteParams = {
    receivedTimestamp,
    meta: {
      chainId,
      dappName,
      dappScheme: 'unused in WC v2', // only used for deeplinks from WC v1
      dappUrl: peerMeta.url || 'Unknown URL',
      imageUrl: maybeSignUri(
        dappLogoOverride(peerMeta?.url) || peerMeta?.icons?.[0]
      ),
      peerId: proposer.publicKey,
    },
    timedOut: false,
    callback: async (approved, approvedChainId, accountAddress) => {
      const client = await signClient;
      const { id, proposer, requiredNamespaces } = proposal.params;

      if (approved) {
        logger.debug(`WC v2: session approved`, {
          approved,
          approvedChainId,
          accountAddress,
        });

        const namespaces: Parameters<
          typeof client.approve
        >[0]['namespaces'] = {};

        for (const [key, value] of Object.entries(requiredNamespaces)) {
          namespaces[key] = {
            accounts: [],
            methods: value.methods,
            events: value.events,
          };

          // TODO do we support connecting to multiple chains at the same time?
          // The sheet def doesn't, only shows one
          for (const chain of value.chains) {
            const chainId = parseInt(chain.split(`${key}:`)[1]);
            namespaces[key].accounts.push(
              `${key}:${chainId}:${accountAddress}`
            );
          }
        }

        logger.debug(`WC v2: session approved namespaces`, { namespaces });

        try {
          /**
           * This is equivalent handling of setPendingRequest and
           * walletConnectApproveSession, since setPendingRequest is only used
           * within the /redux/walletconnect handlers
           *
           * WC v2 stores existing _pairings_ itself, so we don't need to persist
           * ourselves
           */
          const { acknowledged } = await client.approve({
            id,
            namespaces,
          });
          const session = await acknowledged();

          if (hasDeeplinkPendingRedirect) {
            setHasPendingDeeplinkPendingRedirect(false);
            Minimizer.goBack();
          }

          logger.debug(`WC v2: session created`, { session });

          analytics.track('Approved new WalletConnect session', {
            dappName: proposer.metadata.name,
            dappUrl: proposer.metadata.url,
          });
        } catch (e) {
          setHasPendingDeeplinkPendingRedirect(false);

          Alert({
            buttons: [
              {
                style: 'cancel',
                text: lang.t(lang.l.walletconnect.go_back),
              },
            ],
            message: lang.t(lang.l.walletconnect.failed_to_connect_to, {
              appName: dappName,
            }),
            title: lang.t(lang.l.walletconnect.connection_failed),
          });

          logger.error(new RainbowError(`WC v2: session approval failed`), {
            error: (e as Error).message,
          });
        }
      } else if (!approved) {
        setHasPendingDeeplinkPendingRedirect(false);

        logger.debug(`WC v2: session approval denied`, {
          approved,
          chainId,
          accountAddress,
        });

        await client.reject({ id, reason: getSdkError('USER_REJECTED') });

        analytics.track('Rejected new WalletConnect session', {
          dappName: proposer.metadata.name,
          dappUrl: proposer.metadata.url,
        });
      }
    },
  };

  /**
   * We might see this at any point in the app, so only use `replace`
   * sometimes if the user is already looking at the approval sheet.
   */
  Navigation.handleAction(
    Routes.WALLET_CONNECT_APPROVAL_SHEET,
    routeParams,
    getActiveRoute()?.name === Routes.WALLET_CONNECT_APPROVAL_SHEET
  );
}

export async function onSessionRequest(
  event: SignClientTypes.EventArguments['session_request']
) {
  const client = await signClient;

  logger.debug(`WC v2: session_request`, { event });

  const { id, topic } = event;
  const { method, params } = event.params.request;

  if (isSigningMethod(method)) {
    // transactions aren't a `[address, message]` tuple
    const isTransactionMethod = isTransactionDisplayType(method);
    let { address, message } = parseRPCParams({ method, params });
    const allWallets = store.getState().wallets.wallets;

    if (!isTransactionMethod) {
      if (!address || !message) {
        logger.error(
          new RainbowError(
            `WC v2: session_request exited, no address or messsage`
          ),
          {
            address,
            message,
          }
        );

        await client.respond({
          topic,
          response: formatJsonRpcError(id, `Invalid RPC params`),
        });

        return;
      }

      // for TS only, should never happen
      if (!allWallets) {
        logger.error(new RainbowError(`WC v2: allWallets is null`));
        return;
      }

      const selectedWallet = findWalletWithAccount(allWallets, address);

      if (!selectedWallet || selectedWallet?.type === WalletTypes.readOnly) {
        logger.debug(
          `WC v2: session_request exited, selectedWallet was falsy or read only`
        );

        await client.respond({
          topic,
          response: formatJsonRpcError(id, `Wallet is read-only`),
        });

        return;
      }
    } else {
      address = params[0].from;
    }

    const session = client.session.get(topic);
    const { nativeCurrency, network } = store.getState().settings;
    const chainId = Number(event.params.chainId.split(':')[1]);
    const dappNetwork = ethereumUtils.getNetworkFromChainId(chainId);
    const displayDetails = getRequestDisplayDetails(
      event.params.request,
      nativeCurrency,
      dappNetwork
    );
    const peerMeta = session.peer.metadata;
    const request: RequestData = {
      clientId: session.topic, // I don't think this is used
      peerId: session.topic, // I don't think this is used
      requestId: event.id,
      dappName:
        dappNameOverride(peerMeta.name) || peerMeta.name || 'Unknown Dapp',
      dappScheme: 'unused in WC v2', // only used for deeplinks from WC v1
      dappUrl: peerMeta.url || 'Unknown URL',
      displayDetails,
      imageUrl: maybeSignUri(
        dappLogoOverride(peerMeta.url) || peerMeta.icons[0]
      ),
      payload: event.params.request,
      walletConnectV2RequestValues: {
        sessionRequestEvent: event,
        // @ts-ignore we assign address above
        address, // required by screen
        chainId, // required by screen
      },
    };

    logger.debug(`request`, { request });

    const { requests: pendingRequests } = store.getState().requests;

    if (!pendingRequests[request.requestId]) {
      const updatedRequests = {
        ...pendingRequests,
        [request.requestId]: request,
      };
      store.dispatch({
        payload: updatedRequests,
        type: REQUESTS_UPDATE_REQUESTS_TO_APPROVE,
      });
      saveLocalRequests(updatedRequests, address, network);

      logger.debug(`WC v2: navigating to CONFIRM_REQUEST sheet`);

      Navigation.handleAction(Routes.CONFIRM_REQUEST, {
        openAutomatically: true,
        transactionDetails: request,
      });

      analytics.track('Showing Walletconnect signing request', {
        dappName: request.dappName,
        dappUrl: request.dappUrl,
      });
    }
  } else {
    logger.info(`utils/walletConnectV2: received unsupported session_request`);

    await client.respond({
      topic,
      response: formatJsonRpcError(id, `Unsupported RPC method`),
    });
  }
}

/**
 * Handles the result created on our confirmation screen and sends it along to the dapp via WC
 */
export async function handleSessionRequestResponse(
  {
    sessionRequestEvent,
  }: {
    sessionRequestEvent: SignClientTypes.EventArguments['session_request'];
  },
  { result, error }: { result: string; error: any }
) {
  logger.debug(`WC v2: handleSessionRequestResponse`, { result, error });
  logger.info(`WC v2: handleSessionRequestResponse`, {
    success: Boolean(result),
  });

  const client = await signClient;
  const { topic, id } = sessionRequestEvent;

  if (result) {
    const payload = {
      topic,
      response: formatJsonRpcResult(id, result),
    };
    logger.debug(`WC v2: handleSessionRequestResponse success`, { payload });
    await client.respond(payload);
  } else {
    const payload = {
      topic,
      response: formatJsonRpcError(id, error),
    };
    logger.debug(`WC v2: handleSessionRequestResponse reject`, { payload });
    await client.respond(payload);
  }

  store.dispatch(removeRequest(sessionRequestEvent.id));
}
