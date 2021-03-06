'use strict';

const BufferS = require('buffer-shims');
const Transform = require('stream').Transform;
const MimeNode = require('./mime-node');

const HEAD = 0x01;
const BODY = 0x02;

class MessageSplitter extends Transform {
    constructor(config) {
        let options = {
            readableObjectMode: true,
            writableObjectMode: false
        };
        super(options);

        this.config = config || {};
        this.maxHeadSize = this.config.maxHeadSize || Infinity;
        this.state = HEAD;
        this.tree = [];
        this.node = new MimeNode(false);
        this.tree.push(this.node);
        this.line = false;
    }

    _transform(chunk, encoding, callback) {
        // process line by line
        // find next line ending
        let pos = 0;
        let i = 0;
        let group = {
            type: 'none'
        };
        let groupstart = this.line ? -this.line.length : 0;
        let groupend = 0;

        let checkTrailingLinebreak = data => {
            if (data.type === 'body' && data.node.parentNode && data.value && data.value.length) {
                if (data.value[data.value.length - 1] === 0x0A) {
                    groupstart--;
                    groupend--;
                    pos--;
                    if (data.value.length > 1 && data.value[data.value.length - 2] === 0x0D) {
                        groupstart--;
                        groupend--;
                        pos--;
                        if (groupstart < 0 && !this.line) {
                            // store only <CR> as <LF> should be on the positive side
                            this.line = BufferS.allocUnsafe(1);
                            this.line[0] = 0x0D;
                        }
                        data.value = data.value.slice(0, data.value.length - 2);
                    } else {
                        data.value = data.value.slice(0, data.value.length - 1);
                    }
                } else if (data.value[data.value.length - 1] === 0x0D) {
                    groupstart--;
                    groupend--;
                    pos--;
                    data.value = data.value.slice(0, data.value.length - 1);
                }
            }
        };

        let iterateData = () => {
            for (let len = chunk.length; i < len; i++) {
                // find next <LF>
                if (chunk[i] === 0x0A) { // line end

                    let start = Math.max(pos, 0);
                    pos = ++i;

                    return this.processLine(chunk.slice(start, i), false, (err, data, flush) => {
                        if (err) {
                            return setImmediate(() => callback(err));
                        }

                        if (!data) {
                            return iterateData();
                        }

                        if (flush) {
                            if (group && group.type !== 'none') {
                                if (group.type === 'body' && groupend >= groupstart && group.node.parentNode) {
                                    // do not include the last line ending for body
                                    if (chunk[groupend - 1] === 0x0A) {
                                        groupend--;
                                        if (groupend >= groupstart && chunk[groupend - 1] === 0x0D) {
                                            groupend--;
                                        }
                                    }
                                }
                                if (groupstart !== groupend) {
                                    group.value = chunk.slice(groupstart, groupend);
                                    if (groupend < i) {
                                        data.value = chunk.slice(groupend, i);
                                    }
                                }
                                this.push(group);
                                group = {
                                    type: 'none'
                                };
                                groupstart = groupend = i;
                            }
                            this.push(data);
                            groupend = i;
                            return setImmediate(iterateData);
                        }

                        if (data.type === group.type) {
                            // shift slice end position forward
                            groupend = i;
                        } else {
                            if (group.type === 'body' && groupend >= groupstart && group.node.parentNode) {
                                // do not include the last line ending for body
                                if (chunk[groupend - 1] === 0x0A) {
                                    groupend--;
                                    if (groupend >= groupstart && chunk[groupend - 1] === 0x0D) {
                                        groupend--;
                                    }
                                }
                            }

                            if (group.type !== 'none' && group.type !== 'node') {
                                // we have a previous data/body chunk to output
                                if (groupstart !== groupend) {
                                    group.value = chunk.slice(groupstart, groupend);
                                    if (group.value && group.value.length) {
                                        this.push(group);
                                        group = {
                                            type: 'none'
                                        };
                                    }
                                }
                            }

                            if (data.type === 'node') {
                                this.push(data);
                                groupstart = i;
                                groupend = i;
                            } else if (groupstart < 0) {
                                groupstart = i;
                                groupend = i;
                                checkTrailingLinebreak(data);
                                if (data.value && data.value.length) {
                                    this.push(data);
                                }
                            } else {
                                // start new body/data chunk
                                group = data;
                                groupstart = groupend;
                                groupend = i;
                            }
                        }
                        return setImmediate(iterateData);
                    });
                }
            }

            // skip last linebreak for body
            if (pos >= groupstart + 1 && group.type === 'body' && group.node.parentNode) {
                // do not include the last line ending for body
                if (chunk[pos - 1] === 0x0A) {
                    pos--;
                    if (pos >= groupstart && chunk[pos - 1] === 0x0D) {
                        pos--;
                    }
                }
            }

            if (group.type !== 'none' && group.type !== 'node' && pos > groupstart) {
                // we have a leftover data/body chunk to push out
                group.value = chunk.slice(groupstart, pos);

                if (group.value && group.value.length) {
                    this.push(group);
                    group = {
                        type: 'none'
                    };
                }
            }

            if (pos < chunk.length) {
                if (this.line) {
                    this.line = Buffer.concat([this.line, chunk.slice(pos)]);
                } else {
                    this.line = chunk.slice(pos);
                }
            }
            callback();
        };

        iterateData();
    }

    _flush(callback) {
        this.processLine(false, true, (err, data) => {
            if (err) {
                return setImmediate(() => callback(err));
            }
            if (data && (data.type === 'node' || (data.value && data.value.length))) {
                this.push(data);
            }
            callback();
        });
    }

    compareBoundary(line, startpos, boundary) {
        // --{boundary}\r\n or --{boundary}--\r\n
        if (line.length < boundary.length + 3 + startpos || line.length > boundary.length + 6 + startpos) {
            return false;
        }
        for (let i = 0; i < boundary.length; i++) {
            if (line[i + 2 + startpos] !== boundary[i]) {
                return false;
            }
        }

        let pos = 0;
        for (let i = boundary.length + 2 + startpos; i < line.length; i++) {
            let c = line[i];
            if (pos === 0 && (c === 0x0D || c === 0x0A)) {
                // 1: next node
                return 1;
            }
            if (pos === 0 && c !== 0x2D) {
                // expecting "-"
                return false;
            }
            if (pos === 1 && c !== 0x2D) {
                // expecting "-"
                return false;
            }
            if (pos === 2 && c !== 0x0D && c !== 0x0A) {
                // expecting line terminator, either <CR> or <LF>
                return false;
            }
            if (pos === 3 && c !== 0x0A) {
                // expecting line terminator <LF>
                return false;
            }
            pos++;
        }

        // 2: multipart end
        return 2;
    }

    checkBoundary(line) {
        let startpos = 0;
        if (line.length >= 1 && (line[0] === 0x0D || line[0] === 0x0A)) {
            startpos++;
            if (line.length >= 2 && (line[0] === 0x0D || line[1] === 0x0A)) {
                startpos++;
            }
        }
        if (line.length < 4 || line[startpos] !== 0x2D || line[startpos + 1] !== 0x2D) {
            // defnitely not a boundary
            return false;
        }

        let boundary;
        if (this.node._boundary && (boundary = this.compareBoundary(line, startpos, this.node._boundary))) {
            // 1: next child
            // 2: multipart end
            return boundary;
        }

        if (this.node._parentBoundary && (boundary = this.compareBoundary(line, startpos, this.node._parentBoundary))) {
            // 3: next sibling
            // 4: parent end
            return boundary + 2;
        }

        return false;
    }

    processLine(line, final, next) {
        let flush = false;

        if (this.line && line) {
            line = Buffer.concat([this.line, line]);
            this.line = false;
        } else if (this.line && !line) {
            line = this.line;
            this.line = false;
        }

        if (!line) {
            line = BufferS.alloc(0);
        }

        switch (this.state) {
            case HEAD:
                {
                    this.node.addHeaderChunk(line);
                    if (this.node._headerlen > this.maxHeadSize) {
                        let err = new Error('Max header size for a MIME node exceeded');
                        err.code = 'EMAXLEN';
                        return next(err);
                    }
                    if (final || (line.length === 1 && line[0] === 0x0A) || (line.length === 2 && line[0] === 0x0D && line[1] === 0x0A)) {
                        let currentNode = this.node;

                        currentNode.parseHeaders();

                        // if the content is attached message then just continue
                        if (currentNode.contentType === 'message/rfc822' && !this.config.ignoreEmbedded) {
                            this.state = HEAD;
                            this.node = new MimeNode(currentNode);
                            if (currentNode.parentNode) {
                                this.node._parentBoundary = currentNode.parentNode._boundary;
                            }
                        } else {
                            this.state = BODY;
                            if (currentNode.multipart && currentNode._boundary) {
                                this.tree.push(currentNode);
                            }
                        }

                        return next(null, currentNode, flush);
                    }

                    return next();
                }
            case BODY:
                {
                    let boundary = this.checkBoundary(line);
                    if (!boundary) {
                        // not a boundary line
                        if (this.node.multipart) {
                            next(null, {
                                node: this.node,
                                type: 'data',
                                value: line
                            }, flush);
                        } else {
                            next(null, {
                                node: this.node,
                                type: 'body',
                                value: line
                            }, flush);
                        }
                        return;
                    }

                    // reached boundary. switch context
                    switch (boundary) {
                        case 1:
                            // next child
                            this.node = new MimeNode(this.node);
                            this.state = HEAD;
                            flush = true;
                            break;
                        case 2:
                            // reached end of children, keep current node
                            break;
                        case 3:
                            {
                                // next sibling
                                let parentNode = this.node.parentNode;
                                if (parentNode && parentNode.contentType === 'message/rfc822') {
                                    // special case where immediate parent is an inline message block
                                    // move up another step
                                    parentNode = parentNode.parentNode;
                                }
                                this.node = new MimeNode(parentNode);
                                this.state = HEAD;
                                flush = true;
                                break;
                            }
                        case 4:
                            // move up
                            if (this.tree.length) {
                                this.node = this.tree.pop();
                            }
                            this.state = BODY;
                            break;
                    }

                    return next(null, {
                        node: this.node,
                        type: 'data',
                        value: line
                    }, flush);
                }
        }

        next(null, false);
    }
}

module.exports = MessageSplitter;
