function getCaption(obj){
    var index=obj.lastIndexOf("\?");
    obj=obj.substring(index+1,obj.length);
    return obj;
}



var keyword = getCaption(window.location.href);
console.log(keyword);
//  if(!keyWord) return;

var par = {
    docKeywords:keyword,
    pageNo:base16Str("1"),
    sortStyle:base16Str("2"),
    pageSize:base16Str("10")
}
search(par)
function search(par){

    $.ajax({
        url:'/jnetcms/frame/searchKeyword',
        type:'post',
        dataType:'json',
        data:par,
        beforeSend: function () {
            s = layer.load();
        },
        success:function (data) {
            $(".ssListWrap").html("");

            if (data.rows.length <= 0) {
                $(".redCol").html("0");
                var txt = '<li>暂无数据！</li>';
                $(".ssListWrap").append(txt);
                console.log('暂无数据')
            } else {

                $('.redCol0').text(Base64.decode(keyword))
                $('.redCol').text(data.total);
                console.log(data.rows)
                $.each(data.rows, function (index, item) {
                    var txt = '<li class="clearfix"><div class="listCon"><h3><a href="'+item.docPubUrl+ '">' + item.docTitle+ '</a></h3><div class="mt10 listHtml">' + item.docabstract+ '</div></div><div class="infom mt20">'+item.docRelTime+ '&nbsp;&nbsp;&nbsp;&nbsp;' +item.docSource+ '</div></li>';

                    $(".ssListWrap").append(txt);
 $('.ssListWrap').each(function(){
        $(this).find('.listHtml').each(function(){
           if($(this).html()=='' || $(this).html()=='undefined' || $(this).html()==undefined){
            $(this).hide();
            $(this).siblings('h3').css('margin-top','26px') 
            }
         })
       $(this).find('.listHtml p').each(function(){
           $(this).css('color','#999')
         })
       })

                })
            }

            n_page(data, par);


        },
        error: function (XMLHttpRequest, textStatus) {
            top.layer.msg('服务器出错，请联系管理员！', {icon: 2});
        },
        complete: function () {
            layer.close(s);
        }


    });
}
var bool = true;
$(".paix").click(function(){
    if(bool){
        var par = {
            docKeywords:keyword,
            pageNo:base16Str("1"),
            sortStyle:base16Str("1"),
            pageSize:base16Str("10")
        }
        search(par);bool = false;
    }else{
        var par = {
            docKeywords:keyword,
            pageNo:base16Str("1"),
            sortStyle:base16Str("2"),
            pageSize:base16Str("10")
        }
        search(par);bool = true;
    }

})

/** 分页数据 **/
function n_page(data, par) {
    layui.use(['laypage', 'layer'], function () {
        var laypage = layui.laypage
            , layer = layui.layer;
        laypage.render({
            elem: 'demo6'
            , count: data.total
            , curr: base16StrtoStr(par.pageNo)
            , limit: base16StrtoStr(par.pageSize)
            , layout: ['count', 'prev', 'page', 'next', 'limit', 'skip']
            , jump: function (obj, first) {
                par.pageNo = base16Str(obj.curr);
                par.pageSize = base16Str(obj.limit);
                if (!first) { //点击跳页触发函数自身，并传递当前页：obj.curr  ajax 再次请求
                    search(par);
                }
            }
        });
    });
}

