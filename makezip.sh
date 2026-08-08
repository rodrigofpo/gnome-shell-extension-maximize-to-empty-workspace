#!/bin/sh

NAME=MaximizeToEmptyWorkspace-extension@rodrigofpo.br
cd $NAME
zip -r $NAME.zip *
mv $NAME.zip ../..
cd ..

