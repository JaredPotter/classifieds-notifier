require('dotenv').config();
const puppeteer = require('puppeteer');

// Firebase
const functions = require('firebase-functions');
var serviceAccount = require('./serviceAccount.json');
var admin = require('firebase-admin');
const firebase = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://classifieds-notifier.firebaseio.com'
});
const firestore = firebase.firestore()

// Twilio
const twilioSid = process.env.TWILIO_ACCOUNT_SID;
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
const toNumber = process.env.TO_NUMBER;
const fromNumber = process.env.FROM_NUMBER;
const client = require('twilio')(twilioSid, twilioAuthToken);

const config = require('./config.json');
const queries = ['SNES', 'Super Nintendo', 'Game Cube', 'GameCube', 'Fire Emblem'];

// Firebase Function settings.
const runtimeOpts = {
    timeoutSeconds: 300,
    memory: '2GB'
};

// Cron Job Schedule - How Often to trigger the function.
const schedule = '*/15 * * * *'; // Everyday 15 minutes
    
const classifiedsNotifier = async () => {
    console.log('FUNCTION START!');

    // Launch new Chromium instance.
    const browser = await puppeteer.launch({
        headless: true, // Puppeteer is 'headless' by default.
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = (await browser.pages())[0];

    let message = '';
    
    for(let query of queries) {
        if(config.searchKsl) {
            console.log(`Getting KSL Ad Postings... ${query}`);

            const kslUrl = `https://classifieds.ksl.com/search/?keyword=${query}&zip=84093&miles=75&priceFrom=&priceTo=&city=&state=&sort=&perPage=96`;

            message = await executeQuery(query, kslUrl, page, getKslAdPostings, message);
        }

        if(config.searchFacebookMarketplace) {
            console.log(`Getting Facebook Marketplace Ad Postings... ${query}`);
            
            const facebookMarketplaceUrl = `https://www.facebook.com/marketplace/105496622817769/search/?query=${query}&latitude=40.5724&longitude=-111.86&radiusKM=97&vertical=C2C&sort=CREATION_TIME_DESCEND`;
            
            message = await executeQuery(query, facebookMarketplaceUrl, page, getFacebookMarketplaceAdPostings, message);
        }

        if(config.searchCraigslist) {
            console.log(`Getting Craigslist Ad Postings... ${query}`);

            const craigslistUrl = `https://saltlakecity.craigslist.org/search/sss?sort=date&postal=84093&query=${query}&search_distance=75`;

            message = await executeQuery(query, craigslistUrl, page, getCraigslistAdPostings, message);
        }
    }
    // Close the browser.
    browser.close();

    sendMessageToTwilio(message);

    console.log('FUNCTION END!');

    return;
};

async function executeQuery(query, url, page, serviceFunction, message) {

    await page.goto(url, {
        waitUntil: 'networkidle0' // 'networkidle0' is very useful for SPAs.
    });

    const postings = await serviceFunction(page);

    if(postings.length > 0) {
        message = `Query *${query}* Results:\n\n` + message;
        message = appendPostingsToMessage(postings, message);
    }

    return message;
}

async function getKslAdPostings(page) {
    const adPostings = await page.evaluate(() => {
        let adPostingElementList = document.querySelectorAll('.listing-item');

        const postings = [];

        for (let element of adPostingElementList) {
            const title = element.querySelector('.item-info-title-link')
                .textContent;
            const price = element.querySelector('.item-info-price.info-line')
                .textContent;
            const url = element.querySelector('.listing-item-link').href;

            const adPost = {
                title: title,
                price: price,
                url: url
            };

            postings.push(adPost);
        }

        return postings;
    });

    const collectionSnapshot = await firestore.collection('ksl').get();
    const existingPostings = collectionSnapshot.docs.map(doc => doc.data());

    const newPosts = [];

    for (let post of adPostings) {
        const exists = existingPostings.find(p => {
            return p.url === post.url;
        });

        if (!exists) {
            newPosts.push(post);
            await firestore.collection('ksl').add(post);
        }
    }

    console.log(`${newPosts.length} New Posts!`);

    return newPosts;
}

async function getFacebookMarketplaceAdPostings(page) {
    const adPostings = await page.evaluate(() => {
        let adPostingElementList = document.querySelectorAll(
            '[data-testid="marketplace_feed_item"]'
        );

        const postings = [];

        for (let element of adPostingElementList) {
            const title = element.title;
            const price = element.querySelector('div > div > div > div')
                .textContent;
            const url = element.href;

            const adPost = {
                title: title,
                price: price,
                url: url
            };

            postings.push(adPost);
        }

        return postings;
    });

    const collection = firestore.collection('facebookMarketplace');
    const collectionSnapshot = await collection.get();
    const existingPostings = collectionSnapshot.docs.map(doc => doc.data());

    const newPosts = [];

    for (let post of adPostings) {
        const exists = existingPostings.find(p => {
            return p.url === post.url;
        });

        if (!exists) {
            newPosts.push(post);
            await collection.add(post);
        }
    }

    console.log(`${newPosts.length} New Posts!`);

    return newPosts;
}

async function getCraigslistAdPostings(page) {
    const adPostings = await page.evaluate(() => {
        let adPostingElementList = document.querySelectorAll('.result-row');

        const postings = [];

        for (let element of adPostingElementList) {
            const title = element.querySelector('.result-title').textContent;
            const price = element.querySelector('.result-price').textContent;
            const url = element.href;

            const adPost = {
                title: title,
                price: price,
                url: url
            };

            postings.push(adPost);
        }

        return postings;
    });

    const collection = firestore.collection('craigslist');
    const collectionSnapshot = await collection.get();
    const existingPostings = collectionSnapshot.docs.map(doc => doc.data());

    const newPosts = [];

    for (let post of adPostings) {
        const exists = existingPostings.find(p => {
            return p.url === post.url;
        });

        if (!exists) {
            newPosts.push(post);
            await collection.add(post);
        }
    }

    console.log(`${newPosts.length} New Posts!`);

    return newPosts;
}

function appendPostingsToMessage(postings, message) {
    for (let post of postings) {
        message =
            message +
            `Title: ${post.title}\nPrice: ${post.price}\nUrl: ${post.url}\n\n`;
    }

    return message;
}

async function sendMessageToTwilio(message) {
    // Send twilio
    console.log('Getting Message Ready for Twilio...');
    const messagesToSend = [];

    while (message.length > 1600) {
        const newMessagePart = message.substr(0, 1600);
        messagesToSend.push(newMessagePart);
        message = message.substr(1600, message.length);
    }

    if (message) {
        messagesToSend.push(message);
    }

    console.log(`Sending ${messagesToSend.length} messages...`);

    if (messagesToSend.length > 0) {
        for (let m of messagesToSend) {
            console.log('Sending SMS...');
            const response = await client.messages.create({
                body: m,
                from: `${fromNumber}`,
                to: `${toNumber}`
            });
        }

        console.log('Finished Sending SMS.');
    }
}

exports.classifiedsNotifier = functions.runWith(runtimeOpts).pubsub.schedule(schedule).onRun(classifiedsNotifier);
// FOR LOCAL DEV ONLY.
// REMOVE FOR DEPLOYMENT
classifiedsNotifier();