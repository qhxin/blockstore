(function() {
	"use strict";

	// enhance to auto-create directory
	
	// all child processes should open all store.json files for read and just one for write, files shoulds be spread across different partitions
	// the master process should open the blocks.json file for write, all children should tell master when a new block is added
	// master should write the block record and let all other children know about it so that they can read data associate with it, block should be enhanced with file it is in
	// inbound requests should be round-robined
	
	// key: {file: offset: size: }
	
	
	const fs = require("fs"),
		path = require('path'),
		bytePadEnd = (str,length,encoding="utf8") => {
			const needed = length - Buffer.byteLength(str,encoding);
			if(needed>0) { return str + Buffer.alloc(needed," ",encoding).toString(encoding); }
			return str;
		},
		asyncyInline = (thisArg,f,...args) => {
			const cb = (typeof(args[args.length-1])==="function" ? args.pop() : null);
			return new Promise((resolve,reject) => {
				try {
					let timeout,
						outerresult = f.call(thisArg,...args,(err,result) => {
							outerresult = null;
							clearTimeout(timeout);
							if(err) {
								resolve({err,args,result});
							} else {
								if(cb) {
									try {
										cb(null,result);
									} catch(err) {
										resolve({err,args:result});
									}
								}
								resolve({result});
							}
						});
					if(!["nextTick","setTimeout","setInterval"].includes(f.name)) {
						timeout = setTimeout(() => {
							// assume a function that returns a value is not one that invokes a callback
							// there are exceptions, but the programmer will need to handle those
							if(outerresult!=null) {
								if(outerresult instanceof Promise) { outerresult.then((result) => resolve({result})); }
								else if(outerresult instanceof Error) { resolve({err:outerresult}); }
								else { resolve({result:outerresult}); }
							}
						});
					}
				} catch(err) {
					resolve({err,args});
				}
			});
		};
	
	function BlockStore(path,options={clear:false,encoding:"utf8",cache:true,compress:{keys:true,data:false}}) {
		this.path = path;
		this.opened = false;
		this.encoding = options.encoding || "utf8";
		this.cache = (typeof(options.cache)==="boolean" ? options.cache : true);
		Object.defineProperty(this,"length",{enumerable:false,configurable:true,get() { if(typeof(this.keys)==="undefined") { throw new Error("Must open Blockstore to know length"); } return this.keys.length; },set() { throw new Error("BlockStore length is read-only"); }});
		if(options.clear) { this.clear(); }
		else if(!options.compress || options.compress.keys) { this.compress(!options.compress || !options.compress.data); }
	}
	// although it looks asynchronous, clear is synchronous, it is called very little
	BlockStore.prototype.clear = async function() {
		this.close();
		try {
			fs.unlinkSync(this.path + "/blocks.json");
		} catch(e) { true; } // ignore if not there
		try {
			fs.unlinkSync(this.path + "/store.json");
		} catch(e) { true; } // ignore if not there
		this.blocksSize = 0;
		this.storeSize = 0;
		this.blocks = {};
		this.keys = [];
	}
	// close is synchronous, it is called very little
	BlockStore.prototype.close = function() {
		if(this.opened) {
			this.opened = false;
			fs.closeSync(this.blocksfd);
			fs.closeSync(this.storefd);
		}
	}
	BlockStore.prototype.count = async function count() {
		if(!this.opened) { await this.open(); }
		return this.keys.length;
	}
	// compress should only be used when offline
	BlockStore.prototype.compress = async function(keysOnly) {
		const encoding = this.encoding,
			result = {before:{blocks:0,store:0},after:{blocks:0,store:0}};
		if(!this.opened) { await this.open(); }
		let stats = fs.fstatSync(this.blocksfd);
		result.before.blocks = stats.size;
		stats = fs.fstatSync(this.storefd);
		result.before.store = stats.size;
		if(this.keys.length===0) {
			this.clear();
			return result;
		}
		this.blocksSize = 0;
		keysOnly || (this.storeSize = 0);
		const storefd = keysOnly || fs.openSync(this.path + "/compressing.store.json","w"),
			blocksfd = fs.openSync(this.path + "/compressing.blocks.json","w");
		for(let key in this.blocks) {
			const block = this.blocks[key],
				newblock = block.slice();
			newblock[0] = this.storeSize;
			newblock[2] = this.blocksSize;
			let str = '"'+key+'":' + JSON.stringify(newblock)+",";
			fs.writeSync(blocksfd,str,this.blocksSize,encoding); 
			this.blocksSize += Buffer.byteLength(str,encoding);
			if(!keysOnly) {
				const buffer = Buffer.alloc(block[1]);
				fs.readSync(this.storefd,buffer,0,block[1],block[0]);
				str = buffer.toString(this.encoding);
				fs.writeSync(storefd,str,this.storeSize,encoding); 
				this.storeSize += Buffer.byteLength(str,encoding);
			}
		}
		if(!keysOnly) {
			fs.closeSync(storefd);
			fs.closeSync(this.storefd);
			fs.unlinkSync(this.path + "/store.json");
			fs.renameSync(this.path + "/compressing.store.json",this.path + "/store.json");
			this.storefd = fs.openSync(this.path + "/store.json","r+");
		}
		fs.closeSync(blocksfd);
		fs.closeSync(this.blocksfd);
		fs.unlinkSync(this.path + "/blocks.json");
		fs.renameSync(this.path + "/compressing.blocks.json",this.path + "/blocks.json");
		this.blocksfd = fs.openSync(this.path + "/blocks.json","r+");
		stats = fs.fstatSync(this.blocksfd);
		result.after.blocks = stats.size;
		stats = fs.fstatSync(this.storefd);
		result.after.store = stats.size;
		return result;
	}
	BlockStore.prototype.delete = async function(id) {
		if(!this.opened) { await this.open(); }
		const encoding = this.encoding,
			block = this.blocks[id];
		if(block) {
			const blanks = bytePadEnd("",block[1],encoding);
			delete this.blocks[id];
			this.keys = Object.keys(this.blocks);
			this.keys.splice(this.keys.indexOf(id),1);
			//await asyncyInline(fs,fs.write,this.storefd,blanks,block[0],"utf8"); // write blanks to erase data
			await asyncyInline(fs,fs.write,this.blocksfd,bytePadEnd(" ",block[3],this.encoding),block[2],encoding); // write blanks to erase key
			return true;
		}
		return false;
	}
	BlockStore.prototype.removeItem = BlockStore.prototype.delete;
	BlockStore.prototype.flush = function(id) {
		if(this.cache) {
			let hits = 0;
			if(id) {
				const block = this.blocks[id];
				block.cache.value = null;
				hits = block.cache.hits;
				block.cache.hits = 0;
			} else {
				let count = 0;
				for(let id in this.blocks) {
					count++;
					const block = this.blocks[id];
					block.cache.value = null;
					hits += block.cache.hits;
					block.cache.hits = 0;
				}
				hits = hits / count;
			}
			return hits;
		}
	}
	BlockStore.prototype.get = async function(id,block) {
		if(!this.opened) { await this.open(); }
		const encoding = this.encoding,
			currentblock = this.blocks[id];
		if(currentblock) {
			if(this.cache && currentblock.cache && currentblock.cache.value) {
				currentblock.cache.hits++;
				return currentblock.cache.value;
			}
			if(Array.isArray(block)) {
				block[0] = currentblock[0];
				block[1] = currentblock[1];
			} 
			const buffer = Buffer.alloc(currentblock[1]);
			await asyncyInline(fs,fs.read,this.storefd,buffer,0,currentblock[1],currentblock[0]);
			if(this.cache) {
				if(!currentblock.cache) {
					Object.defineProperty(currentblock,"cache",{enumerable:false,configurable:true,writable:true,value:{hits:1}});
				}
				currentblock.cache.value = buffer;
			}
			return buffer;
		}
	}
	BlockStore.prototype.getItem = BlockStore.prototype.get;
	BlockStore.prototype.key = async function(number) {
		if(!this.opened) { await this.open(); }
		return this.keys[number];
	}
	// it is called very little, so uses some synchronous functions for speed and simplicity
	BlockStore.prototype.open = async function(readOnly) { // also add a transactional file class <file>.json, <file>.queue.json, <file>.<line> (line currently processing), <file>.done.json (lines processed)
		if(this.opened) return;
		const encoding = this.encoding;
		let blocks = "";
		
		// ensure directory exists
		this.path
		 .split(path.sep)
		 .reduce((currentPath, folder) => {
		   currentPath += folder + path.sep;
		   if (!fs.existsSync(currentPath)){
		     fs.mkdirSync(currentPath);
		   }
		   return currentPath;
		 }, '');
		if(fs.existsSync(this.path + "/blocks.json")) {
			blocks = fs.readFileSync(this.path + "/blocks.json",encoding);  // {<id>:{start:start,end:end,length:length}[,...]}
			blocks.trim();
		}
		blocks.length===0 || (blocks = blocks.substring(0,blocks.length-1)); // remove trailing comma
		try {
			this.blocks = (blocks.length>0 ? JSON.parse("{" + blocks + "}") : {});
		} catch(e) {
			console.log(e,blocks);
		}
		this.keys = Object.keys(this.blocks);
		if(readOnly) {
			try {
				this.storefd = fs.openSync(this.path + "/store.json","r");
			} catch(e) {
				this.storefd = fs.openSync(this.path + "/store.json","w");
				fs.closeSync(this.storefd);
				this.storefd = fs.openSync(this.path + "/store.json","r");
			}
		} else {
			try {
				this.storefd = fs.openSync(this.path + "/store.json","r+");
			} catch(e) {
				this.storefd = fs.openSync(this.path + "/store.json","w+");
			}
		}
		const storestat = fs.fstatSync(this.storefd);
		this.storeSize = storestat.size;
		try {
			this.blocksfd = fs.openSync(this.path + "/blocks.json","r+");
		} catch(e) {
			this.blocksfd = fs.openSync(this.path + "/blocks.json","w+");
		}
		const blockstat = fs.fstatSync(this.blocksfd);
		this.blocksSize = blockstat.size;
		const lastblock = this.blocks[this.keys[this.keys.length-1]];
		if(!lastblock || (this.storeSize <= lastblock[2]+lastblock[3])) {
			await asyncyInline(fs,fs.write,this.storefd,bytePadEnd(" ",1024*1000,encoding),this.storeSize,encoding);
		} else if(lastblock) {
			this.storeSize = lastblock[2]+lastblock[3];
		}
		this.opened = true;
		return true;
	}
	BlockStore.prototype.set = async function(id,data) {
		if(id==null) return;
		const encoding = this.encoding;
		if(!this.opened) { await this.open(); }
		let block = this.blocks[id];
		if(block) {
			const len = Buffer.byteLength(data,encoding);
			if(block[1]===len) { // if data same size, then overwrite and reset cache
				await asyncyInline(fs,fs.write,this.storefd,data,block[0],encoding);
				!this.cache || Object.defineProperty(block,"cache",{enumerable:false,configurable:true,writable:true,value:{value:data,hits:0}});
				return;
			}
			// otherwise data is not same size and need to append data and block
		} else {
			this.keys.push(id);
		}
		block = [(this.storeSize===0 ? 1 : this.storeSize+1), Buffer.byteLength(data,encoding)]; // allocate free block large enough
		block.push(this.blocksSize); // store the offset of the key and its length with itself, we need this to erase keys
		block.push(Buffer.byteLength(id,this.encoding)+2); // +2 for quotes
		const blockspec = '"'+id+'":'+JSON.stringify(block)+",";
		this.storeSize += block[1];
		await asyncyInline(fs,fs.write,this.storefd,data,block[0],encoding); // write the data with blank padding
		// if we get a failure after here, worst case is block will point to the old value (which, in the interest of performance, we don't overwrite)
		await asyncyInline(fs,fs.write,this.blocksfd,blockspec,this.blockSize,encoding); // write the block spec, i.e. key and offsets
		!this.cache || Object.defineProperty(block,"cache",{enumerable:false,configurable:true,writable:true,value:{value:data,hits:0}});
		this.blocks[id] = block;
		this.blocksSize += Buffer.byteLength(blockspec,encoding); // update eof position
	}
	BlockStore.prototype.setItem = BlockStore.prototype.set;
	module.exports = BlockStore;
}).call(this);