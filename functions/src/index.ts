import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import { PubSub } from '@google-cloud/pubsub';
import * as bus from './bus';
import * as users from './users';
import * as slackApi from './slack/api';
import * as slackAuth from './slack/auth';
import * as slackService from './slack/service';
import { SlackEventCallbackChallenge, SlackEventCallbackBody, ServiceName, SpringOutMessage, SpringOutMessageType, Handler, logHandler, HandleSlackEventCallback, SlackInteractionPayload } from './types';

admin.initializeApp(functions.config().firebase);

// init modules as required
bus.init(new PubSub());
users.init(admin.auth());
slackApi.init(functions.config().slack);
slackAuth.init(admin.firestore());
slackService.init(admin.firestore());

// register handlers for our microservices
const handlers: Handler[] = [
    logHandler,
    slackService.handle,
]

// cast the message to the correct type and call handlers
const handleMessage = async (message: functions.pubsub.Message) => {
    const msg = message.json as SpringOutMessage;
    const t = message.attributes?.type as SpringOutMessageType;
    await callHandlers(msg, t);
}

// call each handler in-turn, catching any errors
const callHandlers = async (msg: SpringOutMessage, t: SpringOutMessageType) => {
    // tslint:disable-next-line: prefer-for-of
    for (let i = 0; i < handlers.length; i++) {
        try {
            await handlers[i](msg, t);
        } catch (err) {
            console.error(err);
        }
    }
}


// subscribe to messages for each microservice's topic
const slackTopic: ServiceName = 'slack';
export const onSlackMessage = functions.pubsub.topic(slackTopic).onPublish(handleMessage);

// // Start writing Firebase Functions
// // https://firebase.google.com/docs/functions/typescript
export const helloWorld = functions.https.onRequest((request, response) => {
    response.send("Hello from Spring Out!");
});

// called when someone installs Slack app from App Store
export const slackDirectInstall = functions.https.onRequest(async (req, res) => {
    console.log("slack direct install", req.query);
    const url = slackApi.getAuthorizeUrl();
    res.redirect(url);
});

// called when someone installing the Spring Out app into 
// their Slack workspace approves the requested Slack permission scopes
export const slackAuthCallback = functions.https.onRequest(async (req, res) => {
    console.log("slack auth callback", req.query);

    const code = req.query.code as string;
    // const state = req.query.state || null;
    const error = req.query.error;

    if (error) {
        console.error(error);
        res.redirect("https://springout.org");
        return;
    }

    // get the access tokens and save in our db
    await slackAuth.exchangeCodeForToken(code);

    // redirect them back to our site, with a nice message
    res.redirect("https://springout.org/slack/linked");
});

// called for specific events which we register for at https://api.slack.com/apps/
export const slackEvent = functions.https.onRequest(async (req, res) => {
    // check if it's a challenge
    const challenge = req.body as SlackEventCallbackChallenge;
    if (challenge.type === 'url_verification') {
        console.log('slack event challenge', challenge);
        res.status(200).json({
            challenge: challenge.challenge
        }).send();
        return;
    }

    // stick it on bus and handle it asynchronously,
    // so we don't get timeouts and slack trying to 
    // re-send us the same event multiple times
    console.log('slack event', req.body);
    const callback = req.body as SlackEventCallbackBody;
    const handleCallback: HandleSlackEventCallback = { callback };
    await bus.publish('slack', handleCallback, 'HandleSlackEventCallback');

    res.sendStatus(200);
});


export const slackInteraction = functions.https.onRequest(async (req, res) => {
    const interaction = JSON.parse(req.body.payload) as SlackInteractionPayload;
    console.log("slack interaction", interaction);

    if (!slackApi.verify(req)) {
        res.sendStatus(400);
        return;
    }

    // stick message on bus as Slack expects response within 3 seconds, otherwise timeout
    const run = slackService.parseInteraction(interaction);
    if (run) {
        await bus.publish('slack', run, 'RunSlackInteraction');
        res.status(200).send();
    } else {
        res.status(200).send('Oops, something went wrong.');
    }
});

// if we delete a user from Firebase console, for example due to a privacy request
// make sure we clean up the associated user data
export const onUserDeleted = functions.auth.user().onDelete(async (user) => {
    await slackService.deleteUser(user.uid);
});

export const onStorageFinalize = functions.storage.object().onFinalize(async (object: any) => {
    const categoryId = String(object.name).split("/", 2)[1];  // get storage location ie cooking
    const fileName = String(object.name).split("/", 3)[2]
    const url = getStorageDownloadUrl(object);

    await admin.firestore().collection('images').doc(categoryId).set({
        [fileName]: url
    }, { merge: true });
});

export const onStorageDelete = functions.storage.object().onDelete(async (object: any) => {
    const categoryId = String(object.name).split("/", 2)[1];  // get storage location ie cooking
    const fileName = String(object.name).split("/", 3)[2]

    await admin.firestore().collection('images').doc(categoryId).set({
        [fileName]: null
    }, { merge: true });
});

// Note: You might _think_ this would be supplied on 
// the AdminSDK, like it is on the WebSDK, but no
const getStorageDownloadUrl = (object: functions.storage.ObjectMetadata) => {
    const { name, bucket, metadata } = object;
    if (!name) {
        throw new Error(`missing name from functions.storage.ObjectMetadata`);
    }
    if (!metadata) {
        throw new Error(`missing metadata from functions.storage.ObjectMetadata`);
    }
    const uri = encodeURIComponent(name);
    const token = metadata.firebaseStorageDownloadTokens;
    const prefix = 'https://firebasestorage.googleapis.com/v0';
    return `${prefix}/b/${bucket}/o/${uri}?alt=media&token=${token}`;
};