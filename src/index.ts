import 'dotenv/config';
import express, {Request,Response,NextFunction} from 'express';
import cors from 'cors';
import {MongoClient,ObjectId} from 'mongodb';
import {jwtVerify} from 'jose';

const app=express();
app.use(cors({origin:process.env.CLIENT_URL||'http://localhost:3000',credentials:true}));
app.use(express.json({limit:'2mb'}));
const port=Number(process.env.PORT||5000);
const uri=process.env.MONGODB_URI;
if(!uri) throw new Error('MONGODB_URI is required');
const secret=process.env.API_JWT_SECRET;
if(!secret||secret.length<32) throw new Error('API_JWT_SECRET must be at least 32 characters');
const key=new TextEncoder().encode(secret);
const client=new MongoClient(uri);
let books:any,borrows:any;
type AuthRequest=Request&{user?:{email:string;name?:string;sub:string}};

async function authenticate(req:AuthRequest,res:Response,next:NextFunction){
 const header=req.headers.authorization;
 if(!header?.startsWith('Bearer ')){res.status(401).json({message:'Please sign in to continue.'});return;}
 try{const {payload}=await jwtVerify(header.slice(7),key,{algorithms:['HS256']});if(typeof payload.sub!=='string'||typeof payload.email!=='string')throw new Error('Invalid token');req.user={sub:payload.sub,email:payload.email,name:typeof payload.name==='string'?payload.name:undefined};next();}
 catch{res.status(401).json({message:'Your session has expired. Please sign in again.'});}
}
const validId=(id:string)=>ObjectId.isValid(id);

// GET /books — public list, newest first. Supports optional ?limit=6.
app.get('/books',(req,res,next)=>{if(req.query.mine==='1')return authenticate(req as AuthRequest,res,next);next()},async(req:AuthRequest,res)=>{try{const limit=Math.min(Math.max(Number(req.query.limit)||0,0),100);const filter=req.query.mine==='1'?{addedByEmail:req.user!.email}:{};let cursor=books.find(filter).sort({createdAt:-1});if(limit)cursor=cursor.limit(limit);res.json(await cursor.toArray())}catch{res.status(500).json({message:'Could not load books.'})}});
// GET /books/:id — book details.
app.get('/books/:id',async(req,res)=>{try{if(!validId(req.params.id))return res.status(400).json({message:'Invalid book ID.'});const book=await books.findOne({_id:new ObjectId(req.params.id)});if(!book)return res.status(404).json({message:'Book not found.'});res.json(book)}catch{res.status(500).json({message:'Could not load this book.'})}});
// POST /books — authenticated owner creates a book.
app.post('/books',authenticate,async(req:AuthRequest,res)=>{try{const {title,author,category,image,description,copies}=req.body||{};if(!title?.trim()||!author?.trim()||!image?.trim()||!description?.trim()||!['Fiction','Science','History','Kids','Others'].includes(category)||!Number.isInteger(copies)||copies<1)return res.status(400).json({message:'Please complete every field with valid values.'});const doc={title:title.trim(),author:author.trim(),category,image:image.trim(),description:description.trim(),copies,addedByName:req.user!.name||req.body.addedByName||'Reader',addedByEmail:req.user!.email,createdAt:new Date()};const result=await books.insertOne(doc);res.status(201).json({...doc,_id:result.insertedId})}catch{res.status(500).json({message:'Could not add this book.'})}});
// PATCH /books/:id — only the book owner may edit.
app.patch('/books/:id',authenticate,async(req:AuthRequest,res)=>{try{if(!validId(req.params.id))return res.status(400).json({message:'Invalid book ID.'});const allowed=['title','author','category','image','description','copies'];const update:any={};for(const field of allowed)if(req.body?.[field]!==undefined)update[field]=req.body[field];if(!Object.keys(update).length)return res.status(400).json({message:'Provide at least one field to update.'});for(const field of ['title','author','image','description'])if(update[field]!==undefined&&(typeof update[field]!=='string'||!update[field].trim()))return res.status(400).json({message:`${field} must be a non-empty string.`});if(update.category!==undefined&&!['Fiction','Science','History','Kids','Others'].includes(update.category))return res.status(400).json({message:'Invalid category.'});if(update.copies!==undefined&&(!Number.isInteger(update.copies)||update.copies<0))return res.status(400).json({message:'Copies must be zero or more.'});const result=await books.updateOne({_id:new ObjectId(req.params.id),addedByEmail:req.user!.email},{$set:update});if(!result.matchedCount)return res.status(404).json({message:'Book not found or you do not own it.'});res.json({message:'Book updated.'})}catch{res.status(500).json({message:'Could not update this book.'})}});
// DELETE /books/:id — only owner; do not delete while copies are borrowed.
app.delete('/books/:id',authenticate,async(req:AuthRequest,res)=>{try{if(!validId(req.params.id))return res.status(400).json({message:'Invalid book ID.'});const id=new ObjectId(req.params.id);const active=await borrows.countDocuments({bookId:id.toString()});if(active)return res.status(409).json({message:'This book has active borrows and cannot be deleted yet.'});const result=await books.deleteOne({_id:id,addedByEmail:req.user!.email});if(!result.deletedCount)return res.status(404).json({message:'Book not found or you do not own it.'});res.json({message:'Book deleted.'})}catch{res.status(500).json({message:'Could not delete this book.'})}});
// POST /borrows — atomically decrements available copies and prevents duplicate active borrows.
app.post('/borrows',authenticate,async(req:AuthRequest,res)=>{const session=client.startSession();try{const {bookId,borrowDate,returnDate}=req.body||{};if(!validId(bookId))return res.status(400).json({message:'Invalid book ID.'});const start=new Date(borrowDate),end=new Date(returnDate);if(Number.isNaN(start.getTime())||Number.isNaN(end.getTime())||end<=start)return res.status(400).json({message:'Please provide valid borrow and return dates.'});let created:any;await session.withTransaction(async()=>{const id=new ObjectId(bookId);const book=await books.findOne({_id:id},{session});if(!book)throw new Error('BOOK_NOT_FOUND');const duplicate=await borrows.findOne({bookId:String(book._id),userEmail:req.user!.email},{session});if(duplicate)throw new Error('DUPLICATE_BORROW');const updated=await books.updateOne({_id:id,copies:{$gt:0}},{$inc:{copies:-1}},{session});if(!updated.modifiedCount)throw new Error('NOT_AVAILABLE');const doc={bookId:String(book._id),bookTitle:book.title,bookImage:book.image,userEmail:req.user!.email,borrowDate:start,returnDate:end,createdAt:new Date()};const result=await borrows.insertOne(doc,{session});created={...doc,_id:result.insertedId};});res.status(201).json(created)}catch(e){const code=(e as Error).message;if(code==='BOOK_NOT_FOUND')res.status(404).json({message:'Book not found.'});else if(code==='DUPLICATE_BORROW')res.status(409).json({message:'You have already borrowed this book. Return it before borrowing again.'});else if(code==='NOT_AVAILABLE')res.status(409).json({message:'Not Available. All copies are currently borrowed.'});else res.status(500).json({message:'Could not borrow this book.'})}finally{await session.endSession()}});
// GET /borrows — only current user's active borrows.
app.get('/borrows',authenticate,async(req:AuthRequest,res)=>{try{res.json(await borrows.find({userEmail:req.user!.email}).sort({borrowDate:-1}).toArray())}catch{res.status(500).json({message:'Could not load borrowed books.'})}});
// DELETE /borrows/:id — return book and restore one available copy.
app.delete('/borrows/:id',authenticate,async(req:AuthRequest,res)=>{const session=client.startSession();try{if(!validId(req.params.id))return res.status(400).json({message:'Invalid borrow ID.'});await session.withTransaction(async()=>{const borrow=await borrows.findOne({_id:new ObjectId(req.params.id),userEmail:req.user!.email},{session});if(!borrow)throw new Error('BORROW_NOT_FOUND');const removed=await borrows.deleteOne({_id:borrow._id,userEmail:req.user!.email},{session});if(!removed.deletedCount)throw new Error('BORROW_NOT_FOUND');await books.updateOne({_id:new ObjectId(borrow.bookId)},{$inc:{copies:1}},{session});});res.json({message:'Book returned successfully.'})}catch(e){res.status((e as Error).message==='BORROW_NOT_FOUND'?404:500).json({message:(e as Error).message==='BORROW_NOT_FOUND'?'Borrow record not found.':'Could not return this book.'})}finally{await session.endSession()}});
app.use((_req,res)=>res.status(404).json({message:'API route not found.'}));
async function start(){await client.connect();const db=client.db(process.env.MONGODB_DB||'booknook');books=db.collection('books');borrows=db.collection('borrows');await borrows.createIndex({bookId:1,userEmail:1},{unique:true});await borrows.createIndex({userEmail:1});await books.createIndex({createdAt:-1});app.listen(port,()=>console.log(`BookNook API running on http://localhost:${port}`));}
start().catch(err=>{console.error('Server startup failed:',err);process.exit(1)});
