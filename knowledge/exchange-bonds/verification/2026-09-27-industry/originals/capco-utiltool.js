/*!
 * 公用js方法
 * wangxuetao
 *
 */

//对提交的form表单数据加密
//fId:要加密的表单id
//sfId:要提交表单id
function base16Form(fId,sfId){
	var values;//接收表单数据
	var tempvalue;
	var index;
	var fhtml = '';
	var timestamp=$("#"+sfId).attr("data-timestamp");
	var nowTime = new Date().getTime();
	var msg;
	if((fId==sfId&&timestamp)||(fId!=sfId&&timestamp&&(nowTime-timestamp)<100)){
		msg="操作过于频繁，稍后再试";
		if(top.layer){
			top.layer.msg(msg);
		}else{
			alert(msg);
		}
		return;
	}else{
		$("#"+sfId).attr("data-timestamp",nowTime);
		values = $('#'+fId).serializeArray();
		for (index = 0; index < values.length; index++){
			tempvalue   = base16Str(values[index].value);
		    fhtml +='<input type="hidden" name="'+values[index].name+'" value="'+tempvalue+'"/>'
		}
		$('#'+sfId).html(fhtml);
	}
}
//单字符加密
function base16Str(str){
	//后续必须把拼字符串换成正常的
	//str=$.trim(str+"");
	str=str+"";
	if (str.length <= 0) {
		return "";
	}
	return getEncodeBase16(str);
	//return encodeURIComponent(encodeURIComponent(getEncodeBase16(str)));
};
//单字符解密,完全没必要.前台2次,后台1次互相解密不通用
function base16StrtoStr(str){
    return getDecodeBase16(str);
	//return getDecodeBase16(decodeURIComponent(str));//解码
}

/*// 单字符加密
function base16Str(str){
	if ($.trim(str).length <= 0) {
		return "";
	}
	return getEncodeBase16(strUnicode2Ansi(str));
};*/
/*
//单字符解密
function base16StrtoStr(str){
	return strAnsi2Unicode(getDecodeBase16(str));//解码
}
*/
//对子iframe中提交的form表单数据加密
//fId:要加密的表单id
//sfId:要提交表单id
//fname:子iframe的name属性值
function base16IframeForm(fId,sfId,fname){
	var values;//接收表单数据
	var tempvalue;
	var index;
	var fhtml = '';
	values = $('#'+fId,window.frames(''+fname+'').document).serializeArray();  
	for (index = 0; index < values.length; index++){
		tempvalue   = base16Str(values[index].value);
	    fhtml +='<input type="hidden" name="'+values[index].name+'" value="'+tempvalue+'"/>'
	}
	$('#'+sfId).html(fhtml);
}

//验证是否为空
function validateEmpty(select,info){
	if($.trim($(select).val()).length>0){
		$(select+"_info").html("校验通过!").attr("class","icon_good");
		return true;
	}else{
		$(select+"_info").html(info).attr("class","icon_bad");
		return false;
	}
}

//验证是否符合正则表达式
function validateRegex(select,info,regex){
	if($(select).val().match(regex)){
		$(select+"_info").html("校验通过!").attr("class","icon_good");
		return true;
	}else{
		$(select+"_info").html(info).attr("class","icon_bad");
		return false;
	}
}

//验证身份证号是否正确
function clsIDCard(CardNo) {
	  this.Valid=false;
	  this.ID15='';
	  this.ID18='';
	  this.Local='';
	  if(CardNo!=null)this.SetCardNo(CardNo);
}
// 构造函数，变量为15位或者18位的身份证号码
function clsIDCard(CardNo) {
    this.Valid=false;
    this.ID15='';
    this.ID18='';
    this.Local='';
    if(CardNo!=null)this.SetCardNo(CardNo);
}

// 设置身份证号码，15位或者18位
clsIDCard.prototype.SetCardNo = function(CardNo) {
    this.ID15='';
    this.ID18='';
    this.Local='';
    CardNo=CardNo.replace(" ","");
    var strCardNo;
    if(CardNo.length==18) {
        pattern= /^\d{17}(\d|x|X)$/;
        if (pattern.exec(CardNo)==null)return;
        strCardNo=CardNo.toUpperCase();
    } else {
        pattern= /^\d{15}$/;
        if (pattern.exec(CardNo)==null)return;
        strCardNo=CardNo.substr(0,6)+'19'+CardNo.substr(6,9)
        strCardNo+=this.GetVCode(strCardNo);
    }
    this.Valid=this.CheckValid(strCardNo);
}

// 校验身份证有效性
clsIDCard.prototype.IsValid = function() {
    return this.Valid;
}

// 返回生日字符串，格式如下，1981-10-10
clsIDCard.prototype.GetBirthDate = function() {
    var BirthDate='';
    if(this.Valid)BirthDate=this.GetBirthYear()+'-'+this.GetBirthMonth()+'-'+this.GetBirthDay();
    return BirthDate;
}

// 返回生日中的年，格式如下，1981
clsIDCard.prototype.GetBirthYear = function() {
    var BirthYear='';
    if(this.Valid)BirthYear=this.ID18.substr(6,4);
    return BirthYear;
}

// 返回生日中的月，格式如下，10
clsIDCard.prototype.GetBirthMonth = function() {
    var BirthMonth='';
    if(this.Valid)BirthMonth=this.ID18.substr(10,2);
    if(BirthMonth.charAt(0)=='0')BirthMonth=BirthMonth.charAt(1);
    return BirthMonth;
}

// 返回生日中的日，格式如下，10
clsIDCard.prototype.GetBirthDay = function() {
    var BirthDay='';
    if(this.Valid)BirthDay=this.ID18.substr(12,2);
    return BirthDay;
}

// 返回性别，1：男，0：女
clsIDCard.prototype.GetSex = function() {
    var Sex='';
    if(this.Valid)Sex=this.ID18.charAt(16)%2;
    return Sex;
}

// 返回15位身份证号码
clsIDCard.prototype.Get15 = function() {
    var ID15='';
    if(this.Valid)ID15=this.ID15;
    return ID15;
}

// 返回18位身份证号码
clsIDCard.prototype.Get18 = function() {
    var ID18='';
    if(this.Valid)ID18=this.ID18;
    return ID18;
}

// 返回所在省，例如：上海市、浙江省
clsIDCard.prototype.GetLocal = function() {
    var Local='';
    if(this.Valid)Local=this.Local;
    return Local;
}

clsIDCard.prototype.GetVCode = function(CardNo17) {
    var Wi = new Array(7,9,10,5,8,4,2,1,6,3,7,9,10,5,8,4,2,1);
    var Ai = new Array('1','0','X','9','8','7','6','5','4','3','2');
    var cardNoSum = 0;
    for (var i=0; i<CardNo17.length; i++)cardNoSum+=CardNo17.charAt(i)*Wi[i];
    var seq = cardNoSum%11;
    return Ai[seq];
}

clsIDCard.prototype.CheckValid = function(CardNo18) {
    if(this.GetVCode(CardNo18.substr(0,17))!=CardNo18.charAt(17))return false;
    if(!this.IsDate(CardNo18.substr(6,8)))return false;
    var aCity={11:"北京",12:"天津",13:"河北",14:"山西",15:"内蒙古",21:"辽宁",22:"吉林",23:"黑龙江 ",31:"上海",32:"江苏",33:"浙江",34:"安徽",35:"福建",36:"江西",37:"山东",41:"河南",42:"湖北 ",43:"湖南",44:"广东",45:"广西",46:"海南",50:"重庆",51:"四川",52:"贵州",53:"云南",54:"西藏 ",61:"陕西",62:"甘肃",63:"青海",64:"宁夏",65:"新疆",71:"台湾",81:"香港",82:"澳门",91:"国外"};
    if(aCity[parseInt(CardNo18.substr(0,2))]==null)return false;
    this.ID18=CardNo18;
    this.ID15=CardNo18.substr(0,6)+CardNo18.substr(8,9);
    this.Local=aCity[parseInt(CardNo18.substr(0,2))];
    return true;
}

clsIDCard.prototype.IsDate = function(strDate) {
    var r = strDate.match(/^(\d{1,4})(\d{1,2})(\d{1,2})$/);
    if(r==null)return false;
    var d= new Date(r[1], r[2]-1, r[3]);
    return (d.getFullYear()==r[1]&&(d.getMonth()+1)==r[2]&&d.getDate()==r[3]);
}
//js uuid
function UUID(){
    this.id = this.createUUID();
}
UUID.prototype.valueOf = function(){ return this.id; };

UUID.prototype.toString = function(){ return this.id; };

UUID.prototype.createUUID = function(){
    var dg = new Date(1582, 10, 15, 0, 0, 0, 0);
    var dc = new Date();
    var t = dc.getTime() - dg.getTime();
    var tl = UUID.getIntegerBits(t,0,31);
    var tm = UUID.getIntegerBits(t,32,47);
    var thv = UUID.getIntegerBits(t,48,59) + '1';
    var csar = UUID.getIntegerBits(UUID.rand(4095),0,7);
    var csl = UUID.getIntegerBits(UUID.rand(4095),0,7);
    var n = UUID.getIntegerBits(UUID.rand(8191),0,7) +
            UUID.getIntegerBits(UUID.rand(8191),8,15) +
            UUID.getIntegerBits(UUID.rand(8191),0,7) +
            UUID.getIntegerBits(UUID.rand(8191),8,15) +
            UUID.getIntegerBits(UUID.rand(8191),0,15);
    return tl + tm  + thv  + csar + csl + n;
};
UUID.getIntegerBits = function(val,start,end){
 var base16 = UUID.returnBase(val,16);
 var quadArray = new Array();
 var quadString = '';
 var i = 0;
 for(i=0;i<base16.length;i++){
     quadArray.push(base16.substring(i,i+1));   
 }
 for(i=Math.floor(start/4);i<=Math.floor(end/4);i++){
     if(!quadArray[i] || quadArray[i] == '') quadString += '0';
     else quadString += quadArray[i];
 }
 return quadString;
};
UUID.returnBase = function(number, base){
 return (number).toString(base).toUpperCase();
};
UUID.rand = function(max){
 return Math.floor(Math.random() * (max + 1));
};

//验证字符是否为空和是否包含特殊字符
function check_str(str,msg){
	if(str.length<=0){
		alert('请输入'+msg+'!');
		return false;
	}
	//else{
	//	var zhong=/^[\u4e00-\u9fa5_a-zA-Z0-9]+$/;
	//	if(!zhong.test(str)){
	//		alert(msg+'不能输入特殊字符');
	//		return false;
	//	}
	//}
	return true;
}
// 验证不能是特殊字符
function valtidateSpecialStr(str, msg, idStr){
	if(str.length<=0){
		$('#'+idStr).next().html('请输入'+msg+'!');
		$('#'+idStr).next().css('color', 'red');
		//document.getElementById(""+ idStr).focus(); 
		scroll(0,0); 
		return false;
	}else{
		var zhong=/^[\u4e00-\u9fa5_a-zA-Z0-9]+$/;
		if(!zhong.test(str)){
			$('#'+idStr).next().html('不能输入特殊字符!');
			$('#'+idStr).next().css('color', 'red');
			//document.getElementById(""+ idStr).focus(); 
			scroll(0,0); 
			return false;
		}
	}
	$('#'+idStr).next().html('验证通过!');
	$('#'+idStr).next().css('color', 'green');
	return true;
}
// 验证不能是特殊字符
function valtidateSpecialStr_new(str, msg, idStr){
	if(str.length<=0){
        layer.tips(msg+'不能为空！', '#'+idStr);
        $('#'+idStr).next().attr('class', '');
        return false;
	}else{
		var zhong=/^[\u4e00-\u9fa5_a-zA-Z0-9]+$/;
		if(!zhong.test(str)){
            layer.tips('请输入正确格式！', '#'+idStr);
            $('#'+idStr).next().attr('class', '');
            return false;
		}
	}
    $('#'+idStr).next().attr('class', 'icon_checkall');
	return true;
}
function check_Null(str, msg, idStr){
	if(str.length<=0){
		$('#'+idStr).next().html('请输入'+msg+'!');
		$('#'+idStr).next().css('color', 'red');
		//document.getElementById(""+ idStr).focus(); 
		scroll(0,0); 
		return false;
	}
	$('#'+idStr).next().html('验证通过!');
	$('#'+idStr).next().css('color', 'green');
	return true;
}
//验证字符是否为空
function check_str2(str,msg){
	if(str.length<=0){
		top.layer.alert('请输入'+msg+'!');
		return false;
	}
	return true;
}
//验证字符是否为空
function check_str2_new(str,msg,id){
	if(str.length<=0){
		layer.tips('请输入'+msg+'!',"#"+id);
		return false;
	}
	return true;
}
//验证字符可以为空
function check_str4(str,msg){
	if(str==null){
		return true;
	}else{
		return true;
	}
	return true;
}
//验证字符是否为空并验证长度
function check_str3(str,msg,num){
	if(str.length<=0){
		alert('请输入'+msg+'!');
		return false;
	}else if (str.length>num){
		alert(msg+'字符过长，请输入长度小于'+num+'的字符!');
		return false;
	}
	return true;
}
// 验证密码
function validatePassword(str,slen,mlen,msg, idStr) {
	 var re1 = /^[1-9]+[0-9]*]*$/;  
	 var re2 = /^[A-Za-z]+$/;  
	if (!check_str_len(str,slen,mlen,msg, idStr)) {
		return false;
	} else if (re1.test(str) || re2.test(str)) {
		$('#'+idStr).next().html(msg+'太简单,必须至少英文和数字!');
		$('#'+idStr).next().css('color', 'red');
		//document.getElementById(""+ idStr).focus(); 
		scroll(0,0); 
		return false;
	}
	$('#'+idStr).next().html('验证通过!');
	$('#'+idStr).next().css('color', 'green');
	return true;
}
// 验证密码
function validatePassword_new(str,slen,mlen,msg, idStr) {
	 var re1 = /^[1-9]+[0-9]*]*$/;
	 var re2 = /^[A-Za-z]+$/;
	if (!check_str_len_new(str,slen,mlen,msg, idStr)) {
		return false;
	} else if (re1.test(str) || re2.test(str)) {
//tips层
        layer.tips(msg+'太简单,必须至少英文和数字!', '#'+idStr);
        $('#'+idStr).next().attr('class', '');
        return false;
	}
	$('#'+idStr).next().attr('class', 'icon_checkall');
	return true;
}
// 验证密码一致
function validateRePassword(password,rePassword,msg, idStr) {
	password = $.trim(password);
	rePassword = $.trim(rePassword);
	if (rePassword != password) {
		$('#'+idStr).next().html('重复密码不一致。');
		$('#'+idStr).next().css('color', 'red');
		return false;
	}
	$('#'+idStr).next().html('验证通过!');
	$('#'+idStr).next().css('color', 'green');
	return true;
}
//验证字符长度
function check_str_len(str,slen,mlen,msg, idStr){
	//最小长度 slen
	//最大长度mlen
	str += '';
	if(str.length<slen||str.length>mlen){
		$('#'+idStr).next().html(msg+'的长度不合法，请输入'+slen+'-'+mlen+'之间的长度!');
		//document.getElementById(""+ idStr).focus(); 
		scroll(0,0); 
		return false;
	} 
	$('#'+idStr).next().html('');
	return true;
}
//验证字符长度
function check_str_len_new(str,slen,mlen,msg, idStr){
	//最小长度 slen
	//最大长度mlen
	str += '';
	if(str.length<slen||str.length>mlen){
        layer.tips(msg+'的长度不合法，请输入'+slen+'-'+mlen+'之间的长度!', '#'+idStr);
        $('#'+idStr).next().attr('class', '');
		return false;
	}
	return true;
}
//验证是否是正整数
function check_positive_integer(str,msg){  
     var re = /^[1-9]+[0-9]*$/;
     if (!re.test(str)){
         top.layer.alert(msg+'不是合法字符，请输入正整数');
        //input.rate.focus();  
        return false;  
     }
     return true;
}
//验证是否是自然数
function check_positive_natural(str){  
     var re = /^[0-9]+[0-9]*]*$/;  
     if (!re.test(str)){  
        return false;  
     }
     return true;
}
function check_phone(str,msg){//验证手机号和电话号码
	var re = /((\d{11})|^((\d{7,8})|(\d{4}|\d{3})-(\d{7,8})|(\d{4}|\d{3})-(\d{7,8})-(\d{4}|\d{3}|\d{2}|\d{1})|(\d{7,8})-(\d{4}|\d{3}|\d{2}|\d{1}))$)/;
	if(!re.test(str)){
        top.layer.alert(msg+'格式不正确,请重新输入');
		 input.rate.focus(); 
		 return false;  
	}
	return true;
}
function check_mobile(str){//验证手机号
	var re = /^1[345789][0-9]{9}$/;
	if(!re.test(str)){
		 return false;  
	}
	return true;
}
function check_phone2(str){//验证手机号和电话号码
	var re = /((\d{11})|^((\d{7,8})|(\d{4}|\d{3})-(\d{7,8})|(\d{4}|\d{3})-(\d{7,8})-(\d{4}|\d{3}|\d{2}|\d{1})|(\d{7,8})-(\d{4}|\d{3}|\d{2}|\d{1}))$)/;
	if(!re.test(str)){
		 return false;  
	}
	return true;
}
//页面alert提示
function alertMsg(msg){
	var html='<div id="dialog_alert" class="dialog confirm" style="left:200px;top:200px;">'+
	      '<div style="height:90px;line-height:90px;border-bottom:1px solid #ccc;text-align:center;font-size:16px;"><span class="alert"></span><span>'+msg+'</span></div>'+
	      '<div style="height:37px;width:250px;line-height:37px;color:#2877C9;text-align: center;font-family:微软雅黑;font-size:15px;cursor:pointer;float:left;"><span onclick="close_alertMsg()">确定</span></div>'+
	      '<div style="clear:both;"></div></div>';
	var dialog=jQuery.dialog({
		width:649,
		height:382,
		content:html
	});
}
function close_alertMsg(){
	$("#dialog_alert").remove();
}
//页面msg提示
function msgDiv(msg){
	$("#innerLayer").remove();
	$("#dialogDiv").remove();
	var html='<div class="dialog publish" style="left:400px;" id="msgDiv"><span class="text">'+msg+'</span>'+
    '<span class="close" onclick="closeMsg()"></span></div>';
	$(window.document.body).append(html);
}
//自定义长度的页面msg提示
function customizeMsgDiv(msg,wid){
	$("#innerLayer").remove();
	$("#dialogDiv").remove();
	var html='<div class="dialog publish" style="left:400px;width:'+wid+'px;" id="msgDiv"><span class="text">'+msg+'</span>'+
    '<span class="close" onclick="closeMsg()"></span></div>';
	$(window.document.body).append(html);
}
//关闭页面msg提示
function closeMsg(){
	$("#msgDiv").remove();
}

// 验证是否有复选框选中，有则返回id,id无则返回false
function validateChecked (warpId) {
	var ids = "";
	$('#'+ warpId).find('input[type="checkbox"]:checked').each(function () {
		var jDom = $(this);
		ids += jDom.val() + ",";
	});
	if (ids != "") {
		return ids.substring(0, ids.length - 1);
	}
	//alert('请选择至少一项!');
	return false;
};
// 邮箱验证
function validateEmail(email, msg, idStr){ 
	//var szReg=/^[a-zA-Z0-9]+([._\\-]*[a-zA-Z0-9])*@([a-zA-Z0-9]+[-a-zA-Z0-9]*[a-zA-Z0-9]+.){1,63}[a-zA-Z0-9]+$/; 
	var szReg=/^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
	var bChk = szReg.test(email); 
	if (! bChk) {
		$('#'+idStr).next().html(msg);
		$('#'+idStr).next().css('color', 'red');
		//document.getElementById(""+ idStr).focus(); 
		scroll(0,0); 
	}else {
		$('#'+idStr).next().html('验证通过!');
		$('#'+idStr).next().css('color', 'green');
	}
	return bChk; 
}; 
// 邮箱验证
function validateEmail_new(email, msg, idStr){
	//var szReg=/^[a-zA-Z0-9]+([._\\-]*[a-zA-Z0-9])*@([a-zA-Z0-9]+[-a-zA-Z0-9]*[a-zA-Z0-9]+.){1,63}[a-zA-Z0-9]+$/;
	var szReg=/^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
	var bChk = szReg.test(email);
	if (! bChk) {
        layer.tips('请输入正确格式！', '#'+idStr);
        $('#'+idStr).next().attr('class', '');
    }else {
        $('#'+idStr).next().attr('class', 'icon_checkall');
	}
	return bChk;
};

function IsURL(str_url){
	//var strRegex = "^(http://)?(https://)?(www.)?([A-Za-z0-9])+(\\.[a-zA-Z]{2,4})+[/\\S]*$";
	//var re=new RegExp(strRegex); 
    var re=/^(?:(?:(?:https?|ftp):)?\/\/)(?:\S+(?::\S*)?@)?(?:(?!(?:10|127)(?:\.\d{1,3}){3})(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z\u00a1-\uffff0-9]-*)*[a-z\u00a1-\uffff0-9]+)(?:\.(?:[a-z\u00a1-\uffff0-9]-*)*[a-z\u00a1-\uffff0-9]+)*(?:\.(?:[a-z\u00a1-\uffff]{2,})).?)(?::\d{2,5})?(?:[/?#]\S*)?$/i;
    if (re.test(str_url)){
        return (true); 
    }else{ 
    	alert('url格式不正确!');
        return (false); 
    }
}
//用于jnetcms应用内部ueditor编辑器附件下载
function downLoadFile(e_url,g){
	window.location = "/jnetcms/cms/ueditor/jsp/downLoadFile.jsp?filePath="+e_url+"&fileName="+g;
}
/* 用于外网ueditor编辑器附件下载,2个参数都是加密的,解密后如:
 * /upload/ueditor/uploadfile/201603/20160316/2016031617371458121047623016867.pdf     
 * GB_T_20003.1-2014_2500.pdf
 * 在ueeditor根目录/jsp downLoadOuterFile.jsp把项目根目录下的这个文件复制到upload应用下
 * 在ueeditor根目录/jsp downLoadFile.jsp?down_center.jsp把项目根目录下的这个文件复制到upload应用下(处理不加密下载)
 */
function downLoadOuterFile(e_url,g){
	window.location = "/upload/downLoadOuterFile.jsp?filePath="+e_url+"&fileName="+g;
}
//获取项目根目录
function getRootPath(){ 
 var pathName = window.location.pathname.substring(1); 
 var webName = pathName == '' ? '' : pathName.substring(0, pathName.indexOf('/')); 
//return window.location.protocol + '//' + window.location.host + '/'+ webName + '/'; 
 return webName;
}
//日期按规定格式显示
Date.prototype.pattern=function(fmt){     
    var o = {     
    "M+" : this.getMonth()+1, //月份     
    "d+" : this.getDate(), //日     
    "h+" : this.getHours()%12 == 0 ? 12 : this.getHours()%12, //小时     
    "H+" : this.getHours(), //小时     
    "m+" : this.getMinutes(), //分     
    "s+" : this.getSeconds(), //秒     
    "q+" : Math.floor((this.getMonth()+3)/3), //季度     
    "S" : this.getMilliseconds() //毫秒     
    };     
    var week = {     
    "0" : "\u65e5",     
    "1" : "\u4e00",     
    "2" : "\u4e8c",     
    "3" : "\u4e09",     
    "4" : "\u56db",     
    "5" : "\u4e94",     
    "6" : "\u516d"    
    };     
    if(/(y+)/.test(fmt)){     
        fmt=fmt.replace(RegExp.$1, (this.getFullYear()+"").substr(4 - RegExp.$1.length));     
    }     
    if(/(E+)/.test(fmt)){     
        fmt=fmt.replace(RegExp.$1, ((RegExp.$1.length>1) ? (RegExp.$1.length>2 ? "\u661f\u671f" : "\u5468") : "")+week[this.getDay()+""]);     
    }     
    for(var k in o){     
        if(new RegExp("("+ k +")").test(fmt)){     
            fmt = fmt.replace(RegExp.$1, (RegExp.$1.length==1) ? (o[k]) : (("00"+ o[k]).substr((""+ o[k]).length)));     
        }     
    }     
    return fmt;     
}

/*
根据〖中华人民共和国国家标准 GB 11643-1999〗中有关公民身份号码的规定，公民身份号码是特征组合码，由十七位数字本体码和一位数字校验码组成。排列顺序从左至右依次为：六位数字地址码，八位数字出生日期码，三位数字顺序码和一位数字校验码。
    地址码表示编码对象常住户口所在县(市、旗、区)的行政区划代码。
    出生日期码表示编码对象出生的年、月、日，其中年份用四位数字表示，年、月、日之间不用分隔符。
    顺序码表示同一地址码所标识的区域范围内，对同年、月、日出生的人员编定的顺序号。顺序码的奇数分给男性，偶数分给女性。
    校验码是根据前面十七位数字码，按照ISO 7064:1983.MOD 11-2校验码计算出来的检验码。

出生日期计算方法。
    15位的身份证编码首先把出生年扩展为4位，简单的就是增加一个19或18,这样就包含了所有1800-1999年出生的人;
    2000年后出生的肯定都是18位的了没有这个烦恼，至于1800年前出生的,那啥那时应该还没身份证号这个东东，⊙﹏⊙b汗...
下面是正则表达式:
 出生日期1800-2099  (18|19|20)?\d{2}(0[1-9]|1[12])(0[1-9]|[12]\d|3[01])
中国1984开始有身份证
 身份证正则表达式 /^\d{6}(18|19|20)?\d{2}(0[1-9]|1[12])(0[1-9]|[12]\d|3[01])\d{3}(\d|X)$/i            
 15位校验规则 6位地址编码+6位出生日期+3位顺序号
 18位校验规则 6位地址编码+8位出生日期+3位顺序号+1位校验位
 
 校验位规则     公式:∑(ai×Wi)(mod 11)……………………………………(1)
                公式(1)中： 
                i----表示号码字符从由至左包括校验码在内的位置序号； 
                ai----表示第i位置上的号码字符值； 
                Wi----示第i位置上的加权因子，其数值依据公式Wi=2^(n-1）(mod 11)计算得出。
                i 18 17 16 15 14 13 12 11 10 9 8 7 6 5 4 3 2 1
                Wi 7 9 10 5 8 4 2 1 6 3 7 9 10 5 8 4 2 1
* 身份证15位编码规则：dddddd yymmdd xx p   
 * dddddd：地区码   
 * yymmdd: 出生年月日   
 * xx: 顺序类编码，无法确定   
 * p: 性别，奇数为男，偶数为女  
 * <p />  
 * 身份证18位编码规则：dddddd yyyymmdd xxx y   
 * dddddd：地区码   
 * yyyymmdd: 出生年月日   
 * xxx:顺序类编码，无法确定，奇数为男，偶数为女   
 * y: 校验码，该位数值可通过前17位计算获得  
 * <p />  
 * 18位号码加权因子为(从右到左) Wi = [ 7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2,1 ] 
 * 验证位 Y = [ 1, 0, 10, 9, 8, 7, 6, 5, 4, 3, 2 ]   
 * 校验位计算公式：Y_P = mod( ∑(Ai×Wi),11 )   
 * i为身份证号码从右往左数的 2...18 位; Y_P为脚丫校验码所在校验码数组位置  
*/
//身份证号合法性验证 
//支持15位和18位身份证号
//支持地址编码、出生日期、校验位验证
//参考http://blog.csdn.net/forlong401/article/details/19407553   http://www.cnblogs.com/lzrabbit/archive/2011/10/23/2221643.html
function isVaildIdCard(code) { 
    var city={11:"北京",12:"天津",13:"河北",14:"山西",15:"内蒙古",21:"辽宁",22:"吉林",23:"黑龙江 ",31:"上海",32:"江苏",33:"浙江",34:"安徽",35:"福建",36:"江西",37:"山东",41:"河南",42:"湖北 ",43:"湖南",44:"广东",45:"广西",46:"海南",50:"重庆",51:"四川",52:"贵州",53:"云南",54:"西藏 ",61:"陕西",62:"甘肃",63:"青海",64:"宁夏",65:"新疆",71:"台湾",81:"香港",82:"澳门",91:"国外 "};
    var tip = "";
    var pass= true;
    var type;
    var regIdCard=/^(^[1-9]\d{5}(8[4-9]|9\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}$)|(^[1-9]\d{5}((18|19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dxX]$)$/;
    if(code){
    	code=code.replace(/(^\s*)|(\s*$)/g, "");
    	if(!(regIdCard.test(code))){
	        tip = "身份证号格式错误";
	        pass = false;
	    }else if(!city[code.substr(0,2)]){
	        tip = "地址编码错误";
	        pass = false;
	    }else{
	        //18位身份证需要验证最后一位校验位
	    	if(code.length == 18){
	    		code = code.split('');
	            //∑(ai×Wi)(mod 11)
	            //加权因子
	            var factor = [ 7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2 ];
	            //校验位
	            var parity = [ 1, 0, 'X', 9, 8, 7, 6, 5, 4, 3, 2 ];
	            var sum = 0;
	            var ai = 0;
	            var wi = 0;
	            for (var i = 0; i < 17; i++)
	            {
	                ai = code[i];
	                wi = factor[i];
	                sum += ai * wi;
	            }
	            var last = parity[sum % 11];
	            if(parity[sum % 11] != code[17]){
	                tip = "校验位错误";
	                pass =false;
	            }
	    	}
	    }
    }else{
    	tip = "错误的参数";
        pass = false;
    }
    if(!pass)alert(tip);
    return pass;
}
function validateIdCard(sId){
	var len=sId.length;
	if(len==18||len==15){
		if(len==15){
			sId=sId.substring(0,5)+"19"+sId.substring(5,16);
		}
		var aCity = {11:"北京",12:"天津",13:"河北",14:"山西",15:"内蒙古",21:"辽宁",22:"吉林",23:"黑龙江 ",31:"上海",32:"江苏",33:"浙江",34:"安徽",35:"福建",36:"江西",37:"山东",41:"河南",42:"湖北 ",43:"湖南",44:"广东",45:"广西",46:"海南",50:"重庆",51:"四川",52:"贵州",53:"云南",54:"西藏 ",61:"陕西",62:"甘肃",63:"青海",64:"宁夏",65:"新疆",71:"台湾",81:"香港",82:"澳门",91:"国外 "};
	    var iSum = 0;
	    sId = sId.replace(/x$/i, "a");
	    if (aCity[parseInt(sId.substr(0, 2))] == null){return false};
	    var sBirthday = sId.substr(6, 4) + "/" + Number(sId.substr(10, 2)) + "/" + Number(sId.substr(12, 2));
	    var d = new Date(sBirthday);
	    if (sBirthday != (d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate())){return false};
	    if(len==18){
		    for (var i = 17; i >= 0; i--){iSum += (Math.pow(2, i) % 11) * parseInt(sId.charAt(17 - i), 11)};
		    if (iSum % 11 != 1){return false}else{return true;};
	    }
	    return true;
	}else{
		return false;
	}
}
//邮箱验证
function validateEmail2(email){ 
	var szReg=/^[a-z0-9]+([._\\-]*[a-z0-9])*@([a-z0-9]+[-a-z0-9]*[a-z0-9]+.){1,63}[a-z0-9]+$/; 
	var bChk = szReg.test(email); 
	return bChk; 
};
//生成随即数,最小值,最大值,小数点位数
function randomNum(min,max,fix){
	return Number((max-min)*Math.random()+min).toFixed(fix);
}
//元数据滚动窗口
function scrollWindow(selector){
	var s=$(selector);
	if(s.length>0){
		var height=s.offset().top;
		if(height>50){
            $(window).scrollTop(height-50);
		}else{
            $(window).scrollTop(height);
		}
	}
}

function obj2string(o){
    var r=[];
    if(typeof o=="string"){
        return "\""+o.replace(/([\'\"\\])/g,"\\$1").replace(/(\n)/g,"\\n").replace(/(\r)/g,"\\r").replace(/(\t)/g,"\\t")+"\"";
    }
    if(typeof o=="object"){
        if(!o.sort){
            for(var i in o){
                r.push(i+":"+obj2string(o[i]));
            }
            if(!!document.all&&!/^\n?function\s*toString\(\)\s*\{\n?\s*\[native code\]\n?\s*\}\n?\s*$/.test(o.toString)){
                r.push("toString:"+o.toString.toString());
            }
            r="{"+r.join()+"}";
        }else{
            for(var i=0;i<o.length;i++){
                r.push(obj2string(o[i]))
            }
            r="["+r.join()+"]";
        }
        return r;
    }
    return o.toString();
}
function getlLocalhostPath(){
    //获取当前网址，如： http://localhost:8088/test/test.jsp
    var curPath = window.document.location.href;
    //获取主机地址之后的目录，如： test/test.jsp
    var pathName = window.document.location.pathname;
    var pos = curPath.indexOf(pathName);
    //获取主机地址，如： http://localhost:8088
    return curPath.substring(0, pos);
}