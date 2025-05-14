import cors from "cors";
import express from "express";
import { ApolloServer , gql } from "apollo-server-express";
import jwt from "jsonwebtoken";
import { DateTimeResolver , JSONResolver } from "graphql-scalars";
import * as dotenv from 'dotenv'
import * as bcrypt from "bcrypt";
import GraphQLUpload from 'graphql-upload/GraphQLUpload.js';
import graphqlUploadExpress from 'graphql-upload/graphqlUploadExpress.js';
import { checkAuth , fetchRole , fetchId} from "./authorizer.ts";
import {PrismaClient } from "@prisma/client";
import {Kafka , Partitioners , logLevel} from "kafkajs";
import {Stripe} from "stripe";

dotenv.config();





(async function () {

    dotenv.config();

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const prisma = new PrismaClient();

    let payments = [{ id: 3, price: 15, studentId: 10001327 }];


    const kafka = new Kafka({
        clientId: "BookingService",
        brokers: [process.env.KAFKA_URL],
    });

    const producer = kafka.producer({
        createPartitioner: Partitioners.LegacyPartitioner
    });

    const consumer = kafka.consumer({ groupId: "PaymentService"});

    await consumer.connect();
    await consumer.subscribe({ topics: ["payment-details" , "refund-request"] , fromBeginning: true});

    async function processRefund(bookingId) {
        const payment = await prisma.payment.findFirst({
            where: {
                bookingId : bookingId
            }
        });
        if(payment === null)
            throw new Error("Payment not found");

        const refund = await stripe.refunds.create({
            payment_intent: payment.paymentIntentId,
            amount: Math.round(payment.amount * 100),
            currency: payment.currency
        });

        await prisma.payment.update({
            where: {
                id : payment.id
            },
            data: {
                status : "Refunded"
            }
        });

        const systemTransaction = await prisma.systemTransaction.create({
            data : {
                type : "Refund",
                amount : payment.amount,
                sentTo : payment.userId
            }
        });
    }

    await consumer.run({
        eachMessage: async ({ topic, partition, message, heartbeat, pause }) => {
            if(topic === "payment-details")
            {
                const payment = JSON.parse(message.value.toString());
                payments.push(payment);
                sendPaymentNotification(payment.id , payment.studentId);
            }
            else if(topic === "refund-request")
            {
                const jsonMessage = JSON.parse(message.value.toString());
                const bookingId = Number(jsonMessage.bookingId);
                processRefund(bookingId);
            }

        },
    });

    const sendBookingPaid = async (bookingId : number , userId : number) => {
        await producer.connect();
        await producer.send({
            topic: "booking-paid",
            messages: [{
                key: bookingId.toString(),
                value: JSON.stringify(bookingId)
            }]
        });
        await producer.send({
            topic: "notificationRequests",
            messages: [{
                key: bookingId.toString(),
                value: JSON.stringify({request: "Payment Confirmed" , subject : "Payment Has Been Confirmed" , message : "Thank you for using GIU Pooling", userId : userId})
            }]
        })
     }
    const sendPaymentNotification = async (bookingId : number , userId : number) => {
        console.log("Entered Function");
        const url = await createPayment(bookingId , userId);
        await producer.connect();
        await producer.send({
            topic: "notificationRequests",
            messages: [{
                key: bookingId.toString(),
                value: JSON.stringify({request: "Payment Request" , subject : "Payment Request for Booking" , message : "Please Pay the Ride . The payment URL is " + url , userId : userId})
            }]
        });
    }

    const fulfillCheckout = async (sessionId : string , bookingId : number , userId : number) => {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        const prismaPayment = await prisma.payment.findFirst({
            where: {
                sessionId : sessionId
            }
        })
        const stringIntent = session.payment_intent.toString();
        await prisma.payment.update({
            where: {
                id : prismaPayment.id
            },
            data : {
                status : "Paid",
                paymentIntentId : stringIntent
            }
        });

        console.log("Session status is: " + session.payment_status);
        if(session.payment_status !== "unpaid")
        {
            await producer.connect();
            await producer.send({
                topic: "booking-paid",
                messages: [{
                    key: bookingId.toString(),
                    value: JSON.stringify(bookingId)
                }]
            });

            await sendBookingPaid(bookingId , userId);
        }
     }
    const createPayment = async (bookingId : number , userId : number) => {
        console.log(payments);
        console.log("Booking Id is: " + bookingId);
        const paymentInfo = payments.find(i => i.id === bookingId);
        console.log(paymentInfo);
        if(paymentInfo === null)
            throw new Error("Cannot find payment request for booking");
        let paymentArray = [paymentInfo]; 
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            line_items: paymentArray.map((payment) => {
                return {
                    price_data : {
                        currency: "egp",
                        product_data: {
                            name: "Payment for Ride with Booking Id #" + payment.id,
                        },
                        unit_amount: payment.price * 200
                    },
                    quantity: 1,
                }
            }),

            mode : "payment",
            success_url: "https://google.com",
            cancel_url: "https://google.com",
        })
        const payment = await prisma.payment.create({
            data : {
                bookingId : bookingId,
                userId : userId,
                amount : paymentInfo.price,
                sessionId : session.id
            }
        });
        console.log("Session URL is: " + session.url);

        return session.url;
    }

    const typeDefs = gql`
        scalar DateTime
        scalar Json

        type Payment {
            id: Int!
            bookingId: Int!
            userId: Int!
            amount: Float!
            status: String!
            paymentIntentId: String
            sessionId: String
            currency: String!
        }

        type SystemTransaction {
            id: Int!
            type: String!
            amount: Float!
            sentTo: Int!
        }

        type Query {
            addCookies(token: String!): String
            fetchAllPayments: [Payment]
            fetchAllSystemTransactions: [SystemTransaction]
            issueRefund(bookingId: Int!): Payment
            redirectToPayment(bookingId: Int!): String
            
        }

        type Mutation {
            createPayment(bookingId: Int! , userId: Int! , amount: Float!): Payment
        }

        type Subscription {
            bookingPaidListener: Payment
        }
    `;

    const resolvers = {
        DateTime : DateTimeResolver,
        Json : JSONResolver,
        Query: {
            addCookies: async(_parent : any , args : any , {req , res} : any) => { 
                 res.cookie("Authorization" , args.token , {expires: new Date(Date.now() + 45000000) , httpOnly: true , secure: true});
                 return "Added Cookie!";
             },
            fetchAllPayments: async(_parent : any , args : any , {req , res} : any) => {
                if(checkAuth(["admin"] , fetchRole(req.headers.cookie)))
                {
                    const payments = await prisma.payment.findMany();
                    return payments;
                }
                else
                {
                    throw new Error("Unauthorized");
                }
            },
            fetchAllSystemTransactions: async(_parent : any , args : any , {req , res} : any) => {
                if(checkAuth(["admin"] , fetchRole(req.headers.cookie)))
                {
                    const systemTransactions = await prisma.systemTransaction.findMany();
                    return systemTransactions;
                }
                else
                {
                    throw new Error("Unauthorized");
                }
            },
            issueRefund: async(_parent : any , args : any , {req , res} : any) => {
                if(checkAuth(["admin"] , fetchRole(req.headers.cookie)))
                {
                    const payment = await prisma.payment.findFirst({
                        where: {
                            bookingId : args.bookingId
                        }
                    });
                    if(payment === null)
                        throw new Error("Payment not found");

                    const refund = await stripe.refunds.create({
                        payment_intent: payment.paymentIntentId,
                        amount: Math.round(payment.amount * 100),
                        currency: payment.currency
                    });

                    await prisma.payment.update({
                        where: {
                            id : payment.id
                        },
                        data: {
                            status : "Refunded"
                        }
                    });

                    const systemTransaction = await prisma.systemTransaction.create({
                        data : {
                            type : "Refund",
                            amount : payment.amount,
                            sentTo : payment.userId
                        }
                    });
                    return payment;
                }
                else
                {
                    throw new Error("Unauthorized");
                }
            },
            redirectToPayment: async(_parent : any , args : any , {req , res} : any) => {
                if(checkAuth(["driver" , "student"] , fetchRole(req.headers.cookie)))
                {
                    const paymentInfo = payments.find(i => i.id === args.bookingId);
                    if(paymentInfo === null)
                        throw new Error("Cannot find payment request for booking");
                    const session = await stripe.checkout.sessions.create({
                        payment_method_types: ["card"],
                        line_items: payments.map((payment) => {
                            return {
                                price_data : {
                                    currency: "egp",
                                    product_data: {
                                        name: "Payment for Ride with Booking Id #" + payment.id,
                                    },
                                    unit_amount: payment.price * 200
                                },
                                quantity: 1,
                            }
                        }),

                        mode : "payment",
                        success_url: "https://google.com",
                        cancel_url: "https://google.com",
                    })
                    console.log("Session URL is: " + session.url);

                    return session.url;
                }
                else
                {
                    throw new Error("Unauthorized");
                }
            }
        },
        Mutation: {
        },
    }

    const app = express() as any;
    var corsOptions = {
        origin : "http://localhost:3000",
        credentials: true
    }
    app.use(cors(corsOptions));

    const server = new ApolloServer({
        typeDefs, 
        resolvers,
        context: async ({req, res}) => ({
            req , res
        }),

    })

    await server.start();
    console.log("Server started");
    await server.applyMiddleware({app , path : "/payment" , cors: false});
    console.log("Middleware Applied!");

    app.post('/webhook', express.raw({type: 'application/json'}), async (request, response) => {

        console.log("Entered Function");
        const payload = request.body;
        const sig = request.headers['stripe-signature'];
      
        let event;

        console.log("Payload is: " + payload);

        console.log("entering try catch");
        try {
          event = stripe.webhooks.constructEvent(payload, sig , process.env.STRIPE_WEBHOOK_SECRET);
        } catch (err) {
            console.log("Error Occured: " + err);
          return response.status(400).send(`Webhook Error: ${err.message}`);
        }
        console.log("Event type is: " + event.type);
        if (
          event.type === 'checkout.session.completed'
          || event.type === 'checkout.session.async_payment_succeeded'
        ) {
            console.log("Event Entered");
            const payment = await prisma.payment.findFirst({
                where: {
                    sessionId : event.data.object.id
                }
            });
          fulfillCheckout(event.data.object.id , payment.bookingId , payment.userId);
        }
      
        response.status(200).end();
      });

    app.listen({port : 4003} , () => {
        console.log("Server is ready at http://localhost:4003" + server.graphqlPath);

    })
})();